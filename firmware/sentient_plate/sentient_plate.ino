/*
 * Cy-Ramick: The Sentient Plate
 * ESP32 DevKit + GY-521 (MPU-6050) + DFPlayer Mini + 5x TCRT5000 (downward-facing IR)
 *
 * The plate talks nonstop. Every clip comes from the folder that matches the
 * plate's current situation. When the situation changes, the current clip
 * fades out and a clip from the new folder fades in.
 *
 * Situations:
 *   Edge of table  Flat, and some (but not all) IR sensors still see the table
 *   Flat           Flat, and either every sensor sees the table (resting)
 *                  or none do (lifted and held level)
 *   Tilt 1-8       Rotated away from flat, in eight angle bands
 *
 * SD card layout (FAT32, <= 32 GB, folders at the card root):
 *   /01/  Edge of table
 *   /02/  Flat
 *   /03/  Tilted  15-35 deg
 *   /04/  Tilted  35-55 deg
 *   /05/  Tilted  55-75 deg
 *   /06/  Tilted  75-95 deg   (on its side)
 *   /07/  Tilted  95-115 deg
 *   /08/  Tilted 115-140 deg
 *   /09/  Tilted 140-165 deg
 *   /10/  Tilted 165-180 deg  (upside down)
 * Name files 001.mp3, 002.mp3, ... inside each folder (up to 255 per folder).
 *
 * Switch the plate on while it rests flat on the table. At boot the sketch
 * records that orientation as "flat" and reads each IR sensor's output level
 * as its "sees the table" level, so neither the GY-521 mounting direction nor
 * the TCRT5000 output polarity needs to be known in advance.
 *
 * Buttons (to GND, internal pull-ups). Every spare even GPIO acts as button 1
 * and every spare odd GPIO as button 2, so touching any of them to GND works:
 *   Button 1 (GPIO 0 = BOOT button, 12, 14, 18)  Wait for lift: fades to silence
 *            and stays quiet until the plate is set on the table and then lifted
 *            off it. Press again to cancel.
 *   Button 2 (GPIO 5, 13, 15, 19, 23)           Mute on/off.
 *
 * Required library: "DFRobotDFPlayerMini" (Arduino Library Manager).
 */

#include <Wire.h>
#include <DFRobotDFPlayerMini.h>
#include <math.h>

// ---------------------------------------------------------------- Pins
const int PIN_I2C_SDA = 21;
const int PIN_I2C_SCL = 22;
const int PIN_DF_RX   = 16;   // ESP32 RX2 <- DFPlayer TX (pin 3)
const int PIN_DF_TX   = 17;   // ESP32 TX2 -> DFPlayer RX (pin 2)
const int PIN_DF_BUSY = 4;    // DFPlayer BUSY (pin 16), LOW while playing. Set -1 if not wired.
const int IR_PINS[]   = {32, 33, 25, 26, 27};
const int NUM_IR      = sizeof(IR_PINS) / sizeof(IR_PINS[0]);

// TCRT5000 polarity. With IR_AUTO_POLARITY the level read at boot (plate on
// the table) is taken as "sees the table". Set it false to use IR_SURFACE_LEVEL.
const bool IR_AUTO_POLARITY = true;
const int  IR_SURFACE_LEVEL = LOW;

// Spare GPIOs only: in-use pins, flash pins (6-11), USB serial (1, 3), the
// onboard LED (2) and input-only pins without pull-ups (34-39) are left out.
const int BTN1_PINS[] = {0, 12, 14, 18};      // Even: wait for lift (GPIO0 is the BOOT button)
const int BTN2_PINS[] = {5, 13, 15, 19, 23};  // Odd: mute
const uint16_t DEBOUNCE_MS = 30;

// ---------------------------------------------------------------- Audio
const uint8_t  VOLUME         = 18;   // 0-30. Higher volume draws current spikes through D2.
const uint16_t FADE_MS        = 600;  // Length of each fade (out or in)
const uint16_t MIN_PLAY_MS    = 900;  // Shortest time a clip plays before a fade can interrupt it
const uint8_t  DEFAULT_TRACKS = 3;    // Used when the DFPlayer cannot report a folder's file count

// ---------------------------------------------------------------- Detection
// Tilt-band boundaries in degrees from flat. Index 0 is "flat"; 1-8 are the tilt folders.
const float    TILT_EDGES[]  = {0, 15, 35, 55, 75, 95, 115, 140, 165, 181};
const int      TILT_BANDS    = 9;     // flat + 8 tilt bands
const float    TILT_HYST_DEG = 4.0;   // Stops chatter at band boundaries
const uint16_t SETTLE_MS     = 250;   // A new situation must hold this long before audio reacts
const uint16_t SAMPLE_MS     = 10;    // 100 Hz sensor loop

// ---------------------------------------------------------------- Folders
const uint8_t FOLDER_EDGE = 1;
const uint8_t FOLDER_FLAT = 2;        // Tilt band n (1-8) plays folder 2 + n
const uint8_t NUM_FOLDERS = 10;

// ---------------------------------------------------------------- MPU-6050
const uint8_t MPU_ADDR = 0x68;        // GY-521 with AD0 floating

DFRobotDFPlayerMini player;

uint8_t trackCount[NUM_FOLDERS + 1];
uint8_t lastTrack[NUM_FOLDERS + 1];
int irSurfaceLevel[NUM_IR];

// Sensor state
float refX = 0, refY = 0, refZ = 1;   // Unit gravity vector when flat
float axF = 0, ayF = 0, azF = 1;      // Low-passed accel, g
float tiltDeg = 0;
int   tiltBand = 0;
int   irOnTable = 0;                  // Number of IR sensors that see the table

// Situation tracking
uint8_t  candidateFolder = FOLDER_FLAT;
uint32_t candidateSince = 0;
uint8_t  targetFolder = FOLDER_FLAT;

// Button-controlled silence
struct Button {
  const int *pins;
  int count;
  int stableLevel;
  int lastRaw;
  uint32_t changedAt;
};
Button btnLift = {BTN1_PINS, sizeof(BTN1_PINS) / sizeof(int), HIGH, HIGH, 0};
Button btnMute = {BTN2_PINS, sizeof(BTN2_PINS) / sizeof(int), HIGH, HIGH, 0};
bool muted = false;
bool waitingForLift = false;
bool liftSawTable = false;            // The plate must be seen on the table before a lift counts
uint32_t offTableSince = 0;

// Audio state machine
enum AudioState { PLAYING, FADING_OUT, FADING_IN, SILENT };
AudioState audioState = PLAYING;
uint8_t  playingFolder = 0;
uint8_t  currentVolume = 0;
uint32_t trackStartedAt = 0;
uint32_t lastFadeStep = 0;
uint32_t busyHighSince = 0;
const uint16_t FADE_STEP_MS   = max(25, FADE_MS / VOLUME);  // DFPlayer needs ~25 ms between commands
const uint16_t START_GUARD_MS = 500;  // BUSY takes a moment to drop after a play command

// ================================================================ MPU-6050

void mpuWrite(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.write(val);
  Wire.endTransmission();
}

bool mpuReadAccel(float &ax, float &ay, float &az) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x3B);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(MPU_ADDR, (uint8_t)6) != 6) return false;

  int16_t raw[3];
  for (int i = 0; i < 3; i++) raw[i] = (Wire.read() << 8) | Wire.read();
  ax = raw[0] / 16384.0f;  // +-2 g
  ay = raw[1] / 16384.0f;
  az = raw[2] / 16384.0f;
  return true;
}

void mpuInit() {
  mpuWrite(0x6B, 0x00);  // Wake up
  mpuWrite(0x1A, 0x03);  // Digital low-pass filter ~44 Hz
  mpuWrite(0x1C, 0x00);  // Accel +-2 g
  delay(100);
}

// ================================================================ Calibration

// Average readings while the plate rests flat to get the reference "down" vector.
void calibrateTilt() {
  float sx = 0, sy = 0, sz = 0;
  int got = 0;
  for (int i = 0; i < 200; i++) {
    float ax, ay, az;
    if (mpuReadAccel(ax, ay, az)) {
      sx += ax; sy += ay; sz += az;
      got++;
    }
    delay(5);
  }
  if (got == 0) {
    Serial.println("MPU-6050 not responding; check SDA/SCL wiring.");
    return;
  }
  float mag = sqrtf(sx * sx + sy * sy + sz * sz);
  refX = sx / mag; refY = sy / mag; refZ = sz / mag;
  axF = refX; ayF = refY; azF = refZ;
}

// Record each sensor's "sees the table" level by majority vote over a short window.
void calibrateIR() {
  for (int i = 0; i < NUM_IR; i++) {
    pinMode(IR_PINS[i], INPUT);
    if (!IR_AUTO_POLARITY) {
      irSurfaceLevel[i] = IR_SURFACE_LEVEL;
      continue;
    }
    int highs = 0;
    for (int n = 0; n < 50; n++) {
      highs += digitalRead(IR_PINS[i]);
      delay(2);
    }
    irSurfaceLevel[i] = highs > 25 ? HIGH : LOW;
    Serial.printf("IR %d (GPIO%d): table reads %s\n", i + 1, IR_PINS[i],
                  irSurfaceLevel[i] == HIGH ? "HIGH" : "LOW");
  }
}

// ================================================================ Detection

int classifyTilt(float deg, int current) {
  // Stay in the current band until the angle is clearly past its boundary.
  if (deg >= TILT_EDGES[current] - TILT_HYST_DEG &&
      deg <  TILT_EDGES[current + 1] + TILT_HYST_DEG) {
    return current;
  }
  for (int b = 0; b < TILT_BANDS; b++) {
    if (deg >= TILT_EDGES[b] && deg < TILT_EDGES[b + 1]) return b;
  }
  return TILT_BANDS - 1;
}

void updateSensors() {
  float ax, ay, az;
  if (mpuReadAccel(ax, ay, az)) {
    const float A = 0.15f;  // Accel smoothing
    axF += A * (ax - axF);
    ayF += A * (ay - ayF);
    azF += A * (az - azF);

    float mag = sqrtf(axF * axF + ayF * ayF + azF * azF);
    if (mag > 0.2f) {  // Skip free fall or a bad read; keep the previous angle
      float c = (axF * refX + ayF * refY + azF * refZ) / mag;
      tiltDeg = degrees(acosf(constrain(c, -1.0f, 1.0f)));
      tiltBand = classifyTilt(tiltDeg, tiltBand);
    }
  }

  irOnTable = 0;
  for (int i = 0; i < NUM_IR; i++) {
    if (digitalRead(IR_PINS[i]) == irSurfaceLevel[i]) irOnTable++;
  }
}

uint8_t detectFolder() {
  if (tiltBand > 0) return FOLDER_FLAT + tiltBand;
  if (irOnTable > 0 && irOnTable < NUM_IR) return FOLDER_EDGE;
  return FOLDER_FLAT;
}

void updateTarget() {
  uint8_t f = detectFolder();
  uint32_t now = millis();
  if (f != candidateFolder) {
    candidateFolder = f;
    candidateSince = now;
  } else if (now - candidateSince >= SETTLE_MS) {
    targetFolder = candidateFolder;
  }
}

// ================================================================ Audio

uint8_t pickTrack(uint8_t folder) {
  uint8_t n = trackCount[folder];
  if (n <= 1) return 1;
  uint8_t t;
  do { t = random(1, n + 1); } while (t == lastTrack[folder]);  // No immediate repeats
  lastTrack[folder] = t;
  return t;
}

void startTrack(uint8_t folder) {
  player.playFolder(folder, pickTrack(folder));
  playingFolder = folder;
  trackStartedAt = millis();
  busyHighSince = 0;
}

void setVolume(uint8_t v) {
  currentVolume = v;
  player.volume(v);
}

bool trackFinished() {
  uint32_t now = millis();
  bool guarded = now - trackStartedAt < START_GUARD_MS;

  // Drain DFPlayer messages; a "play finished" report ends the clip.
  bool finishedMsg = false;
  while (player.available()) {
    if (player.readType() == DFPlayerPlayFinished) finishedMsg = true;
  }
  if (guarded) return false;
  if (finishedMsg) return true;

  if (PIN_DF_BUSY >= 0) {
    if (digitalRead(PIN_DF_BUSY) == HIGH) {
      if (busyHighSince == 0) busyHighSince = now;
      return now - busyHighSince > 150;  // Ignore brief glitches on the BUSY line
    }
    busyHighSince = 0;
  }
  return false;
}

void updateAudio() {
  uint32_t now = millis();
  bool silent = muted || waitingForLift;

  switch (audioState) {
    case PLAYING:
      if (silent || (targetFolder != playingFolder && now - trackStartedAt >= MIN_PLAY_MS)) {
        audioState = FADING_OUT;
        lastFadeStep = now;
      } else if (trackFinished()) {
        // Keep talking: chain straight into another clip for the current situation.
        startTrack(targetFolder);
      }
      break;

    case FADING_OUT:
      if (now - lastFadeStep >= FADE_STEP_MS) {
        lastFadeStep = now;
        if (currentVolume > 0) {
          setVolume(currentVolume - 1);
        } else if (silent) {
          player.stop();
          audioState = SILENT;
        } else {
          startTrack(targetFolder);
          audioState = FADING_IN;
        }
      }
      break;

    case FADING_IN:
      if (silent) {
        audioState = FADING_OUT;  // Fade back down from wherever the fade-in reached
      } else if (now - lastFadeStep >= FADE_STEP_MS) {
        lastFadeStep = now;
        if (currentVolume < VOLUME) {
          setVolume(currentVolume + 1);
        } else {
          audioState = PLAYING;
        }
      }
      break;

    case SILENT:
      while (player.available()) player.readType();  // Discard stale DFPlayer messages
      if (!silent) {
        startTrack(targetFolder);
        audioState = FADING_IN;
        lastFadeStep = now;
      }
      break;
  }
}

void loadTrackCounts() {
  for (uint8_t f = 1; f <= NUM_FOLDERS; f++) {
    int n = player.readFileCountsInFolder(f);
    trackCount[f] = (n > 0 && n < 256) ? n : DEFAULT_TRACKS;
    lastTrack[f] = 0;
    Serial.printf("Folder %02u: %u tracks%s\n", f, trackCount[f], n > 0 ? "" : " (default)");
    delay(50);
  }
}

// ================================================================ Buttons

// Returns true once per press (debounced HIGH -> LOW transition).
// LOW if any pin in the button's group is pulled to GND.
int readButton(const Button &b) {
  for (int i = 0; i < b.count; i++) {
    if (digitalRead(b.pins[i]) == LOW) return LOW;
  }
  return HIGH;
}

bool pressed(Button &b) {
  int raw = readButton(b);
  uint32_t now = millis();
  if (raw != b.lastRaw) {
    b.lastRaw = raw;
    b.changedAt = now;
  }
  if (raw != b.stableLevel && now - b.changedAt >= DEBOUNCE_MS) {
    b.stableLevel = raw;
    return raw == LOW;
  }
  return false;
}

void updateButtons() {
  if (pressed(btnLift)) {
    waitingForLift = !waitingForLift;
    liftSawTable = false;
    offTableSince = 0;
    Serial.println(waitingForLift ? "Waiting for lift" : "Wait for lift cancelled");
  }
  if (pressed(btnMute)) {
    muted = !muted;
    Serial.println(muted ? "Muted" : "Unmuted");
  }
}

// Clears "wait for lift" once the plate has been on the table and then leaves it.
void updateLiftWait() {
  if (!waitingForLift) return;
  uint32_t now = millis();
  if (irOnTable > 0) {
    liftSawTable = true;
    offTableSince = 0;
  } else if (liftSawTable) {
    if (offTableSince == 0) offTableSince = now;
    if (now - offTableSince >= SETTLE_MS) {
      waitingForLift = false;
      Serial.println("Lifted");
    }
  }
}

// ================================================================ Main

void setup() {
  Serial.begin(115200);
  if (PIN_DF_BUSY >= 0) pinMode(PIN_DF_BUSY, INPUT_PULLUP);
  for (int p : BTN1_PINS) pinMode(p, INPUT_PULLUP);
  for (int p : BTN2_PINS) pinMode(p, INPUT_PULLUP);
  randomSeed(esp_random());

  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  mpuInit();
  calibrateTilt();
  calibrateIR();

  // ACK disabled: commands return immediately (needed for smooth fades) and it
  // avoids the timeouts some HiLetgo clones show with the stock library.
  Serial2.begin(9600, SERIAL_8N1, PIN_DF_RX, PIN_DF_TX);
  player.begin(Serial2, false, true);
  player.setTimeOut(500);
  loadTrackCounts();

  // Let the filters settle, then start talking immediately.
  for (int i = 0; i < 30; i++) { updateSensors(); delay(SAMPLE_MS); }
  targetFolder = candidateFolder = detectFolder();
  setVolume(0);
  startTrack(targetFolder);
  audioState = FADING_IN;
  lastFadeStep = millis();
}

void loop() {
  static uint32_t lastSample = 0, lastLog = 0;
  uint32_t now = millis();

  if (now - lastSample >= SAMPLE_MS) {
    lastSample = now;
    updateSensors();
    updateTarget();
    updateLiftWait();
  }

  updateButtons();
  updateAudio();

  if (now - lastLog >= 250) {
    lastLog = now;
    Serial.printf("tilt=%6.1f band=%d irOnTable=%d/%d target=%02u playing=%02u vol=%u%s%s\n",
                  tiltDeg, tiltBand, irOnTable, NUM_IR, targetFolder, playingFolder, currentVolume,
                  muted ? " MUTED" : "", waitingForLift ? " WAITING" : "");
  }
}
