/*
 * Cy-Ramick: The Sentient Plate
 * ESP32 + MPU6050 (tilt/motion) + DFPlayer Mini (audio) + IR cliff sensor (table edge)
 *
 * The plate talks nonstop. Every clip comes from the folder that matches the
 * plate's current situation. When the situation changes, the current clip
 * fades out and a clip from the new folder fades in.
 *
 * SD card layout (FAT32, folders at the card root):
 *   /01/  On the edge of a table (flat, still, and the cliff sensor sees no surface)
 *   /02/  Flat (held level in the hand, or resting on the table)
 *   /03/  Tilted  15-35 deg
 *   /04/  Tilted  35-55 deg
 *   /05/  Tilted  55-75 deg
 *   /06/  Tilted  75-95 deg   (roughly vertical)
 *   /07/  Tilted  95-115 deg
 *   /08/  Tilted 115-140 deg
 *   /09/  Tilted 140-165 deg
 *   /10/  Tilted 165-180 deg  (upside down)
 * Name files 001.mp3, 002.mp3, ... inside each folder.
 *
 * Power the plate on while it lies flat. The resting orientation at boot
 * becomes the "flat" reference, so the MPU6050 can be mounted either way up.
 *
 * Required library: "DFRobotDFPlayerMini" (Arduino Library Manager).
 */

#include <Wire.h>
#include <DFRobotDFPlayerMini.h>
#include <math.h>

// ---------------------------------------------------------------- Pins
const int PIN_I2C_SDA     = 21;
const int PIN_I2C_SCL     = 22;
const int PIN_DF_RX       = 16;   // ESP32 RX2 <- DFPlayer TX
const int PIN_DF_TX       = 17;   // ESP32 TX2 -> DFPlayer RX (through a 1k resistor)
const int PIN_DF_BUSY     = 4;    // DFPlayer BUSY (LOW while playing). Set -1 if not wired.
const int PIN_CLIFF       = 27;   // IR cliff sensor digital out (e.g. TCRT5000 module)
const int CLIFF_SURFACE_LEVEL = LOW;  // Pin level when the sensor sees a surface

// ---------------------------------------------------------------- Audio
const uint8_t VOLUME         = 24;    // 0-30
const uint16_t FADE_MS       = 600;   // Length of each fade (out or in)
const uint16_t MIN_PLAY_MS   = 900;   // Shortest time a clip plays before a fade can interrupt it
const uint8_t DEFAULT_TRACKS = 3;     // Used when the DFPlayer cannot report a folder's file count

// ---------------------------------------------------------------- Detection
// Tilt-band boundaries in degrees from flat. Index 0 is "flat"; 1-8 are the tilt folders.
const float TILT_EDGES[] = {0, 15, 35, 55, 75, 95, 115, 140, 165, 181};
const int   TILT_BANDS   = 9;         // flat + 8 tilt bands
const float TILT_HYST_DEG    = 4.0;   // Stops chatter at band boundaries
const float MOTION_DPS       = 3.0;   // Above this rotation rate the plate counts as "handled"
const uint16_t SETTLE_MS     = 250;   // A new situation must hold this long before audio reacts
const uint16_t SAMPLE_MS     = 10;    // 100 Hz sensor loop

// ---------------------------------------------------------------- Folders
const uint8_t FOLDER_EDGE = 1;
const uint8_t FOLDER_FLAT = 2;        // Tilt band n (1-8) plays folder 2 + n
const uint8_t NUM_FOLDERS = 10;

// ---------------------------------------------------------------- MPU6050
const uint8_t MPU_ADDR = 0x68;

HardwareSerial dfSerial(2);
DFRobotDFPlayerMini player;

uint8_t trackCount[NUM_FOLDERS + 1];
uint8_t lastTrack[NUM_FOLDERS + 1];

// Sensor state
float refX = 0, refY = 0, refZ = 1;         // Unit gravity vector when flat
float gBiasX = 0, gBiasY = 0, gBiasZ = 0;   // Gyro bias, deg/s
float axF = 0, ayF = 0, azF = 1;            // Low-passed accel, g
float gyroF = 0;                            // Low-passed rotation rate, deg/s
float tiltDeg = 0;
int   tiltBand = 0;

// Situation tracking
uint8_t candidateFolder = FOLDER_FLAT;
uint32_t candidateSince = 0;
uint8_t targetFolder = FOLDER_FLAT;

// Audio state machine
enum AudioState { PLAYING, FADING_OUT, FADING_IN };
AudioState audioState = PLAYING;
uint8_t playingFolder = 0;
uint8_t currentVolume = 0;
uint32_t trackStartedAt = 0;
uint32_t lastFadeStep = 0;
uint32_t busyHighSince = 0;
const uint16_t FADE_STEP_MS = max(25, FADE_MS / VOLUME);  // DFPlayer needs ~25 ms between commands
const uint16_t START_GUARD_MS = 500;   // BUSY takes a moment to drop after a play command

// ================================================================ MPU6050

void mpuWrite(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.write(val);
  Wire.endTransmission();
}

bool mpuRead(float &ax, float &ay, float &az, float &gx, float &gy, float &gz) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x3B);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(MPU_ADDR, (uint8_t)14) != 14) return false;

  int16_t raw[7];
  for (int i = 0; i < 7; i++) raw[i] = (Wire.read() << 8) | Wire.read();

  ax = raw[0] / 16384.0f;  // +-2 g
  ay = raw[1] / 16384.0f;
  az = raw[2] / 16384.0f;
  gx = raw[4] / 131.0f;    // +-250 deg/s
  gy = raw[5] / 131.0f;
  gz = raw[6] / 131.0f;
  return true;
}

void mpuInit() {
  mpuWrite(0x6B, 0x00);  // Wake up
  mpuWrite(0x1A, 0x03);  // Digital low-pass filter ~44 Hz
  mpuWrite(0x1B, 0x00);  // Gyro +-250 deg/s
  mpuWrite(0x1C, 0x00);  // Accel +-2 g
  delay(100);
}

// Average readings while the plate sits still to get the flat reference and gyro bias.
void calibrate() {
  const int N = 200;
  float sx = 0, sy = 0, sz = 0, bx = 0, by = 0, bz = 0;
  int got = 0;
  for (int i = 0; i < N; i++) {
    float ax, ay, az, gx, gy, gz;
    if (mpuRead(ax, ay, az, gx, gy, gz)) {
      sx += ax; sy += ay; sz += az;
      bx += gx; by += gy; bz += gz;
      got++;
    }
    delay(5);
  }
  if (got == 0) {
    Serial.println("MPU6050 not responding; check wiring.");
    return;
  }
  float mag = sqrtf(sx * sx + sy * sy + sz * sz);
  refX = sx / mag; refY = sy / mag; refZ = sz / mag;
  gBiasX = bx / got; gBiasY = by / got; gBiasZ = bz / got;
  axF = refX; ayF = refY; azF = refZ;
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
  float ax, ay, az, gx, gy, gz;
  if (!mpuRead(ax, ay, az, gx, gy, gz)) return;

  const float A = 0.15f;  // Accel smoothing
  axF += A * (ax - axF);
  ayF += A * (ay - ayF);
  azF += A * (az - azF);

  gx -= gBiasX; gy -= gBiasY; gz -= gBiasZ;
  float rate = sqrtf(gx * gx + gy * gy + gz * gz);
  gyroF += 0.1f * (rate - gyroF);

  float mag = sqrtf(axF * axF + ayF * ayF + azF * azF);
  if (mag < 0.2f) return;  // Free fall or bad read; keep the previous angle
  float c = (axF * refX + ayF * refY + azF * refZ) / mag;
  c = constrain(c, -1.0f, 1.0f);
  tiltDeg = degrees(acosf(c));
  tiltBand = classifyTilt(tiltDeg, tiltBand);
}

uint8_t detectFolder() {
  if (tiltBand > 0) return FOLDER_FLAT + tiltBand;

  bool seesSurface = digitalRead(PIN_CLIFF) == CLIFF_SURFACE_LEVEL;
  bool still = gyroF < MOTION_DPS;
  if (!seesSurface && still) return FOLDER_EDGE;
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

  switch (audioState) {
    case PLAYING:
      if (targetFolder != playingFolder && now - trackStartedAt >= MIN_PLAY_MS) {
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
        } else {
          startTrack(targetFolder);
          audioState = FADING_IN;
        }
      }
      break;

    case FADING_IN:
      if (now - lastFadeStep >= FADE_STEP_MS) {
        lastFadeStep = now;
        if (currentVolume < VOLUME) {
          setVolume(currentVolume + 1);
        } else {
          audioState = PLAYING;
        }
      }
      break;
  }
}

void loadTrackCounts() {
  for (uint8_t f = 1; f <= NUM_FOLDERS; f++) {
    int n = player.readFileCountsInFolder(f);
    trackCount[f] = (n > 0 && n < 256) ? n : DEFAULT_TRACKS;
    lastTrack[f] = 0;
    Serial.printf("Folder %02u: %u tracks\n", f, trackCount[f]);
    delay(50);
  }
}

// ================================================================ Main

void setup() {
  Serial.begin(115200);
  pinMode(PIN_CLIFF, INPUT);
  if (PIN_DF_BUSY >= 0) pinMode(PIN_DF_BUSY, INPUT_PULLUP);
  randomSeed(esp_random());

  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  mpuInit();
  calibrate();

  dfSerial.begin(9600, SERIAL_8N1, PIN_DF_RX, PIN_DF_TX);
  if (!player.begin(dfSerial, false, true)) {
    Serial.println("DFPlayer not found; check wiring and SD card.");
  }
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
  }

  updateAudio();

  if (now - lastLog >= 250) {
    lastLog = now;
    Serial.printf("tilt=%6.1f band=%d rate=%5.1f cliff=%d target=%02u playing=%02u vol=%u\n",
                  tiltDeg, tiltBand, gyroF, digitalRead(PIN_CLIFF),
                  targetFolder, playingFolder, currentVolume);
  }
}
