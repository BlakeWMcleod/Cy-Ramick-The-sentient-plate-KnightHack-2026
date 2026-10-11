/*
 * Cy-Ramick plate: hardware self-test
 *
 * Tests every part of the plate, reports each failure as a beep code, and
 * saves the results in the ESP32's flash so they survive a power-off.
 *
 * SD card: only two files are needed, copied to the card root IN THIS ORDER
 * onto an empty card (the DFPlayer numbers root files by copy order):
 *   1st: Beep.mp3        prompts and passes
 *   2nd: Metal Beep.mp3  errors
 * If the sounds come out swapped, swap BEEP_TRACK and ERROR_TRACK below.
 *
 * How to run:
 *   1. Set the plate flat on the table and switch it on.
 *   2. Two beeps = pick the plate up, tilt it onto its side, then set it back down (15 s).
 *   3. Two beeps = press button 1 (10 s). One beep confirms each step.
 *   4. Two beeps = press button 2 (10 s).
 *   5. One beep and a steady LED = everything passed.
 *      Otherwise each failure plays METAL beeps for the error code, then normal
 *      beeps for which sensor or button (if any).
 *   6. Press either button any time afterwards to hear the result again.
 *
 * Error codes (metal beeps):
 *   1  DFPlayer not responding (LED and Serial only)  - check TX/RX wires and DFPlayer power
 *   2  SD card not readable, or fewer than 2 files    - FAT32 card, <= 32 GB, both MP3s copied
 *   3  DFPlayer BUSY wire not working                 - DFPlayer pin 16 to GPIO4
 *   4  MPU-6050 not found on I2C                      - SDA GPIO21, SCL GPIO22, 3V3, GND
 *   5  MPU-6050 bad data; then 1 = gravity reading wrong, 2 = readings frozen, 3 = no tilt seen
 *   6  IR sensor wire disconnected; then sensor number - DO wire to its GPIO
 *   7  IR sensor did not react when lifted; then sensor number - VCC/GND, or turn its trimpot
 *   8  Button stuck pressed; then button number        - shorted to GND
 *   9  Button not pressed during the test; then button number - wiring, or not installed yet
 *   10 Last restart was a brownout                     - weak batteries or power wiring (D1/VIN)
 *
 * Hold button 1 while switching on to replay the last saved report without testing.
 * The full report is also printed on Serial at 115200 baud.
 *
 * Required library: "DFRobotDFPlayerMini" (Arduino Library Manager).
 */

#include <Wire.h>
#include <Preferences.h>
#include <DFRobotDFPlayerMini.h>
#include <esp_system.h>
#include <math.h>

// ---------------------------------------------------------------- Pins
const int PIN_DF_RX   = 16;
const int PIN_DF_TX   = 17;
const int PIN_DF_BUSY = 4;
const int PIN_SDA     = 21;
const int PIN_SCL     = 22;
const int IR_PINS[]   = {32, 33, 25, 26, 27};
const int NUM_IR      = sizeof(IR_PINS) / sizeof(IR_PINS[0]);
const int BTN_PINS[]  = {18, 19};
const int NUM_BTN     = 2;
const int PIN_LED     = 2;      // Onboard LED on the ESP32 DevKit

// ---------------------------------------------------------------- Audio
const uint8_t BEEP_TRACK  = 1;  // Beep.mp3
const uint8_t ERROR_TRACK = 2;  // Metal Beep.mp3
const uint8_t VOLUME      = 20;

// ---------------------------------------------------------------- Test timing
const uint32_t LIFT_WINDOW_MS   = 15000;
const uint32_t BUTTON_WINDOW_MS = 10000;
const float    TILT_PASS_DEG    = 30.0;

const uint8_t MPU_ADDR = 0x68;

// ---------------------------------------------------------------- Results
struct Failure {
  uint8_t code;
  uint8_t detail;   // Sensor or button number, 0 if none
};

const int MAX_FAILURES = 24;
Failure failures[MAX_FAILURES];
int numFailures = 0;

DFRobotDFPlayerMini player;
Preferences prefs;
bool audioOk = false;
bool busyOk = false;
bool mpuOk = false;

const char *describe(uint8_t code) {
  switch (code) {
    case 1:  return "DFPlayer not responding (check TX/RX wires and DFPlayer power)";
    case 2:  return "SD card not readable or fewer than 2 files";
    case 3:  return "DFPlayer BUSY wire not working (DFPlayer pin 16 to GPIO4)";
    case 4:  return "MPU-6050 not found on I2C (SDA 21, SCL 22, 3V3, GND)";
    case 5:  return "MPU-6050 bad data (1 gravity wrong, 2 frozen, 3 no tilt seen)";
    case 6:  return "IR sensor wire disconnected (DO wire)";
    case 7:  return "IR sensor did not react when lifted (VCC/GND or trimpot)";
    case 8:  return "Button stuck pressed (shorted to GND)";
    case 9:  return "Button not pressed during the test (wiring or not installed)";
    case 10: return "Last restart was a brownout (weak batteries or power wiring)";
    default: return "Unknown";
  }
}

void fail(uint8_t code, uint8_t detail = 0) {
  if (numFailures < MAX_FAILURES) failures[numFailures++] = {code, detail};
  Serial.printf("  FAIL %u", code);
  if (detail) Serial.printf(".%u", detail);
  Serial.printf(": %s\n", describe(code));
}

void pass(const char *what) {
  Serial.printf("  pass: %s\n", what);
}

// ================================================================ Sound and LED

void led(bool on) { digitalWrite(PIN_LED, on ? HIGH : LOW); }

// Plays one track and waits for it to finish. Falls back to a fixed wait if BUSY is broken.
void playTrack(uint8_t track) {
  led(true);
  if (audioOk) {
    player.play(track);
    if (busyOk) {
      uint32_t t = millis();
      while (digitalRead(PIN_DF_BUSY) == HIGH && millis() - t < 1000) delay(5);
      while (digitalRead(PIN_DF_BUSY) == LOW && millis() - t < 8000) delay(5);
    } else {
      delay(1200);
    }
  } else {
    delay(400);
  }
  led(false);
  delay(250);
}

void beeps(uint8_t track, int n) {
  for (int i = 0; i < n; i++) playTrack(track);
}

// LED-only version of a code: long blinks for the code, short blinks for the detail.
void blinkCode(uint8_t code, uint8_t detail) {
  for (int i = 0; i < code; i++) { led(true); delay(600); led(false); delay(400); }
  delay(800);
  for (int i = 0; i < detail; i++) { led(true); delay(150); led(false); delay(350); }
}

void announce(const Failure *list, int n) {
  if (n == 0) {
    beeps(BEEP_TRACK, 1);
    led(true);
    return;
  }
  for (int i = 0; i < n; i++) {
    if (audioOk) {
      beeps(ERROR_TRACK, list[i].code);
      delay(800);
      beeps(BEEP_TRACK, list[i].detail);
    } else {
      blinkCode(list[i].code, list[i].detail);
    }
    delay(2000);
  }
}

// ================================================================ Saved results

void saveResults() {
  prefs.begin("selftest", false);
  prefs.putUInt("runs", prefs.getUInt("runs", 0) + 1);
  prefs.putUChar("count", numFailures);
  prefs.putBytes("fails", failures, numFailures * sizeof(Failure));
  prefs.end();
}

int loadResults(Failure *out, uint32_t &runs) {
  prefs.begin("selftest", true);
  runs = prefs.getUInt("runs", 0);
  int n = prefs.getUChar("count", 0);
  if (n > MAX_FAILURES) n = MAX_FAILURES;
  if (n) prefs.getBytes("fails", out, n * sizeof(Failure));
  prefs.end();
  return n;
}

void printReport(const Failure *list, int n, uint32_t run) {
  Serial.printf("\n===== Self-test report (run %lu) =====\n", (unsigned long)run);
  if (n == 0) Serial.println("All tests passed.");
  for (int i = 0; i < n; i++) {
    Serial.printf("Code %u", list[i].code);
    if (list[i].detail) Serial.printf(".%u", list[i].detail);
    Serial.printf("  %s\n", describe(list[i].code));
  }
  Serial.println("======================================\n");
}

// ================================================================ MPU-6050

void mpuWrite(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.write(val);
  Wire.endTransmission();
}

bool mpuRead(int16_t raw[7]) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x3B);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(MPU_ADDR, (uint8_t)14) != 14) return false;
  for (int i = 0; i < 7; i++) raw[i] = (Wire.read() << 8) | Wire.read();
  return true;
}

bool mpuGravity(float &x, float &y, float &z) {
  int16_t r[7];
  if (!mpuRead(r)) return false;
  x = r[0] / 16384.0f; y = r[1] / 16384.0f; z = r[2] / 16384.0f;
  return true;
}

// ================================================================ Tests

void testBrownout() {
  Serial.println("[Power]");
  if (esp_reset_reason() == ESP_RST_BROWNOUT) fail(10);
  else pass("no brownout on last restart");
}

void testDFPlayer() {
  Serial.println("[DFPlayer + SD card]");
  pinMode(PIN_DF_BUSY, INPUT_PULLUP);
  Serial2.begin(9600, SERIAL_8N1, PIN_DF_RX, PIN_DF_TX);
  player.begin(Serial2, false, true);
  player.setTimeOut(800);

  int files = -1;
  for (int i = 0; i < 3 && files < 0; i++) {
    while (player.available()) player.readType();
    files = player.readFileCounts();
    delay(100);
  }
  if (files < 0) {
    fail(1);
    return;
  }
  audioOk = true;
  pass("DFPlayer responding");
  Serial.printf("  %d file(s) on the card\n", files);
  if (files < 2) fail(2);
  else pass("SD card readable");

  for (uint8_t f = 1; f <= 10; f++) {
    int n = player.readFileCountsInFolder(f);
    Serial.printf("  info: folder %02u has %d track(s)%s\n", f, n < 0 ? 0 : n,
                  n > 0 ? "" : " (needed later by the main firmware)");
  }

  player.volume(VOLUME);
  delay(100);
  if (files < 1) return;

  // BUSY must drop while a track plays.
  player.play(BEEP_TRACK);
  uint32_t t = millis();
  while (digitalRead(PIN_DF_BUSY) == HIGH && millis() - t < 1500) delay(5);
  busyOk = digitalRead(PIN_DF_BUSY) == LOW;
  while (digitalRead(PIN_DF_BUSY) == LOW && millis() - t < 8000) delay(5);
  if (busyOk) pass("BUSY wire");
  else { fail(3); delay(1500); }
  Serial.println("  (You should have just heard Beep.mp3. If not, check the speaker wires.)");
}

void testMPU() {
  Serial.println("[MPU-6050]");
  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.beginTransmission(MPU_ADDR);
  if (Wire.endTransmission() != 0) {
    Wire.beginTransmission(0x69);
    if (Wire.endTransmission() == 0) Serial.println("  note: found at 0x69; AD0 is pulled high, leave it floating");
    fail(4);
    return;
  }
  mpuWrite(0x6B, 0x00);
  mpuWrite(0x1A, 0x03);
  mpuWrite(0x1C, 0x00);
  mpuWrite(0x1B, 0x00);
  delay(100);

  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x75);
  Wire.endTransmission(false);
  Wire.requestFrom(MPU_ADDR, (uint8_t)1);
  Serial.printf("  WHO_AM_I = 0x%02X\n", Wire.available() ? Wire.read() : 0);

  float sum = 0;
  int16_t first[7], r[7];
  bool frozen = true;
  int got = 0;
  for (int i = 0; i < 50; i++) {
    if (!mpuRead(r)) continue;
    if (got == 0) memcpy(first, r, sizeof(first));
    else if (memcmp(first, r, sizeof(first)) != 0) frozen = false;
    float x = r[0] / 16384.0f, y = r[1] / 16384.0f, z = r[2] / 16384.0f;
    sum += sqrtf(x * x + y * y + z * z);
    got++;
    delay(10);
  }
  if (got == 0) { fail(4); return; }
  float g = sum / got;
  Serial.printf("  gravity = %.2f g (expect ~1.00)\n", g);
  mpuOk = true;
  if (g < 0.85f || g > 1.15f) { fail(5, 1); mpuOk = false; }
  else if (frozen) { fail(5, 2); mpuOk = false; }
  else pass("readings look right");
}

int irBaseline[NUM_IR];

void testIRWiring() {
  Serial.println("[IR sensors: wiring]");
  for (int i = 0; i < NUM_IR; i++) {
    // A connected module drives the pin; a loose wire follows the internal pull resistor.
    pinMode(IR_PINS[i], INPUT_PULLUP);
    delay(5);
    int up = digitalRead(IR_PINS[i]);
    pinMode(IR_PINS[i], INPUT_PULLDOWN);
    delay(5);
    int down = digitalRead(IR_PINS[i]);
    pinMode(IR_PINS[i], INPUT);
    delay(5);
    irBaseline[i] = digitalRead(IR_PINS[i]);
    if (up == HIGH && down == LOW) fail(6, i + 1);
    else Serial.printf("  pass: IR %d (GPIO%d) connected, on table reads %s\n", i + 1, IR_PINS[i],
                       irBaseline[i] ? "HIGH" : "LOW");
  }
}

void testButtonsStuck() {
  Serial.println("[Buttons: stuck check]");
  for (int i = 0; i < NUM_BTN; i++) {
    pinMode(BTN_PINS[i], INPUT_PULLUP);
    delay(5);
    if (digitalRead(BTN_PINS[i]) == LOW) fail(8, i + 1);
    else Serial.printf("  pass: button %d (GPIO%d) not stuck\n", i + 1, BTN_PINS[i]);
  }
}

void testLiftAndTilt() {
  Serial.println("[Lift and tilt] Pick the plate up, tilt it onto its side, then set it back down.");
  beeps(BEEP_TRACK, 2);

  float rx = 0, ry = 0, rz = 1;
  if (mpuOk) mpuGravity(rx, ry, rz);
  float refMag = sqrtf(rx * rx + ry * ry + rz * rz);

  bool changed[NUM_IR] = {false};
  float maxTilt = 0;
  uint32_t t = millis();
  while (millis() - t < LIFT_WINDOW_MS) {
    for (int i = 0; i < NUM_IR; i++) {
      if (digitalRead(IR_PINS[i]) != irBaseline[i]) changed[i] = true;
    }
    float x, y, z;
    if (mpuOk && refMag > 0.5f && mpuGravity(x, y, z)) {
      float m = sqrtf(x * x + y * y + z * z);
      if (m > 0.5f) {
        float c = constrain((x * rx + y * ry + z * rz) / (m * refMag), -1.0f, 1.0f);
        maxTilt = fmaxf(maxTilt, (float)degrees(acosf(c)));
      }
    }
    bool allChanged = true;
    for (int i = 0; i < NUM_IR; i++) allChanged &= changed[i];
    if (allChanged && (!mpuOk || maxTilt >= TILT_PASS_DEG)) break;
    delay(10);
  }
  // Give the user a moment to finish setting it down.
  delay(1500);
  beeps(BEEP_TRACK, 1);

  for (int i = 0; i < NUM_IR; i++) {
    if (changed[i]) Serial.printf("  pass: IR %d reacted\n", i + 1);
    else fail(7, i + 1);
  }
  if (mpuOk) {
    Serial.printf("  max tilt = %.0f deg\n", maxTilt);
    if (maxTilt >= TILT_PASS_DEG) pass("tilt detected");
    else fail(5, 3);
  }
}

void testButtonPress(int i) {
  Serial.printf("[Button %d] Press button %d now.\n", i + 1, i + 1);
  beeps(BEEP_TRACK, 2);
  uint32_t t = millis();
  bool pressed = false;
  while (millis() - t < BUTTON_WINDOW_MS) {
    if (digitalRead(BTN_PINS[i]) == LOW) {
      delay(30);
      if (digitalRead(BTN_PINS[i]) == LOW) { pressed = true; break; }
    }
    delay(5);
  }
  if (pressed) {
    pass("button pressed");
    beeps(BEEP_TRACK, 1);
    while (digitalRead(BTN_PINS[i]) == LOW) delay(10);  // Wait for release
  } else {
    fail(9, i + 1);
  }
}

// ================================================================ Main

void setup() {
  Serial.begin(115200);
  pinMode(PIN_LED, OUTPUT);
  led(false);
  delay(500);
  Serial.println("\nCy-Ramick plate self-test");

  // Show the previous run's saved report first.
  Failure saved[MAX_FAILURES];
  uint32_t runs;
  int savedCount = loadResults(saved, runs);
  if (runs > 0) {
    Serial.println("Previous saved report:");
    printReport(saved, savedCount, runs);
  }

  // Hold button 1 at power-on to replay the saved report without testing.
  pinMode(BTN_PINS[0], INPUT_PULLUP);
  delay(20);
  bool replayOnly = digitalRead(BTN_PINS[0]) == LOW && runs > 0;

  testBrownout();
  testDFPlayer();

  if (replayOnly) {
    Serial.println("Button 1 held: replaying the saved report.");
    memcpy(failures, saved, sizeof(Failure) * savedCount);
    numFailures = savedCount;
    return;
  }

  testMPU();
  testIRWiring();
  testButtonsStuck();
  testLiftAndTilt();
  for (int i = 0; i < NUM_BTN; i++) testButtonPress(i);

  saveResults();
  prefs.begin("selftest", true);
  uint32_t run = prefs.getUInt("runs", 0);
  prefs.end();
  printReport(failures, numFailures, run);
  delay(1000);
}

bool anyButtonPressed() {
  for (int i = 0; i < NUM_BTN; i++) {
    if (digitalRead(BTN_PINS[i]) == LOW) {
      delay(30);
      if (digitalRead(BTN_PINS[i]) == LOW) {
        while (digitalRead(BTN_PINS[i]) == LOW) delay(10);  // Wait for release
        return true;
      }
    }
  }
  return false;
}

void loop() {
  static bool announced = false;
  if (!announced || anyButtonPressed()) {
    announced = true;
    led(false);
    delay(1500);  // Keep the result apart from the last confirmation beep
    announce(failures, numFailures);
  }
  delay(10);
}
