/* GFLUX parts library.
 *
 * Every part is a real, commonly sold hobby module. Pin names and pin order
 * follow the silkscreen of the module as usually sold. Geometry is in grid
 * units where 1 grid = 2.54 mm (0.1"), so header pins land on real pitch and
 * the PCB export keeps real spacing.
 *
 * pins: an array (one row along the bottom edge) or {left, right, top, bottom}
 *       arrays listed top-to-bottom / left-to-right.
 * code: Arduino snippets. [[PIN]] becomes the ESP32 GPIO wired to that pin,
 *       [[ANY]] the first wired GPIO, [[n]] the instance number.
 */
window.GFLUX = window.GFLUX || {};

GFLUX.COLORS = [
  { key: 'R', name: 'Red',    hex: '#e53935' },
  { key: 'O', name: 'Orange', hex: '#fb8c00' },
  { key: 'Y', name: 'Yellow', hex: '#fdd835' },
  { key: 'G', name: 'Green',  hex: '#43a047' },
  { key: 'B', name: 'Blue',   hex: '#1e88e5' },
  { key: 'I', name: 'Indigo', hex: '#3f51b5' },
  { key: 'V', name: 'Violet', hex: '#8e24aa' },
  { key: 'W', name: 'White',  hex: '#f4f4f4' },
  { key: 'K', name: 'Black',  hex: '#1c1c1c' },
];
GFLUX.colorHex = (key) => (GFLUX.COLORS.find((c) => c.key === key) || GFLUX.COLORS[3]).hex;

// One ROYGBIVWB colour per library compartment, like a jumper-wire kit box.
GFLUX.CATEGORIES = [
  { id: 'boards',  name: 'Boards',   color: 'R' },
  { id: 'basics',  name: 'Basics',   color: 'O' },
  { id: 'lights',  name: 'Lights',   color: 'Y' },
  { id: 'sensors', name: 'Sensors',  color: 'G' },
  { id: 'input',   name: 'Input',    color: 'B' },
  { id: 'screens', name: 'Screens',  color: 'I' },
  { id: 'motors',  name: 'Motors',   color: 'V' },
  { id: 'sound',   name: 'Sound & Storage', color: 'W' },
  { id: 'power',   name: 'Power',    color: 'K' },
  { id: 'custom',  name: 'My Parts', color: 'G' },
];

const PCB = { blue: '#1f4e9c', black: '#222326', green: '#1d6b3a', red: '#a3242c', purple: '#5a2d82', yellow: '#c99a1c', white: '#e8e8e8' };

const ESP32_GPIO = {
  VP: 36, VN: 39, D34: 34, D35: 35, D32: 32, D33: 33, D25: 25, D26: 26, D27: 27, D14: 14, D12: 12, D13: 13,
  D23: 23, D22: 22, TX0: 1, RX0: 3, D21: 21, D19: 19, D18: 18, D5: 5, TX2: 17, RX2: 16, D4: 4, D2: 2, D15: 15,
};
const C3_GPIO = { IO0: 0, IO1: 1, IO2: 2, IO3: 3, IO4: 4, IO5: 5, IO6: 6, IO7: 7, IO8: 8, IO9: 9, IO10: 10, IO20: 20, IO21: 21 };

GFLUX.PARTS = [
  // ---------------------------------------------------------------- Boards
  {
    id: 'esp32', name: 'ESP32 board', mpn: 'ESP32-DevKit-V1', cat: 'boards', ref: 'U',
    full: 'ESP32-WROOM-32 DevKit V1 Development Board (30-pin, USB)',
    q: 'ESP32 ESP-WROOM-32 development board 30 pin', board: PCB.black, art: 'esp32', w: 10, h: 18,
    controller: true, gpio: ESP32_GPIO, i2c: { SDA: 21, SCL: 22 },
    rails: { '3V3': '3V3', VIN: '5V', GND: 'GND' },
    inputOnly: ['VP', 'VN', 'D34', 'D35'],
    caution: { EN: 'EN is the reset pin', TX0: 'TX0 is used by USB serial', RX0: 'RX0 is used by USB serial', D12: 'D12 must be LOW at boot', D2: 'D2 drives the onboard LED' },
    tip: 'Your circuit\'s brain. Runs Arduino code, has Wi-Fi and Bluetooth. Use 3V3 for most sensors.',
    pins: {
      left: ['EN', 'VP', 'VN', 'D34', 'D35', 'D32', 'D33', 'D25', 'D26', 'D27', 'D14', 'D12', 'D13', 'GND', 'VIN'],
      right: ['D23', 'D22', 'TX0', 'RX0', 'D21', 'D19', 'D18', 'D5', 'TX2', 'RX2', 'D4', 'D2', 'D15', 'GND', '3V3'],
    },
  },
  {
    id: 'esp32c3', name: 'Mini ESP32 board', mpn: 'ESP32-C3-SuperMini', cat: 'boards', ref: 'U',
    full: 'ESP32-C3 SuperMini Development Board (USB-C, Wi-Fi + BLE)',
    q: 'ESP32-C3 SuperMini development board', board: PCB.blue, art: 'c3', w: 6, h: 9,
    controller: true, gpio: C3_GPIO, i2c: { SDA: 8, SCL: 9 },
    rails: { '5V': '5V', '3V3': '3V3', GND: 'GND' },
    caution: { IO9: 'IO9 is the BOOT button pin', IO2: 'IO2 is a boot strapping pin', IO8: 'IO8 drives the onboard LED', IO20: 'IO20 is serial RX', IO21: 'IO21 is serial TX' },
    tip: 'Thumb-sized ESP32. Fewer pins, same Arduino code.',
    pins: {
      left: ['5V', 'GND', '3V3', 'IO4', 'IO3', 'IO2', 'IO1', 'IO0'],
      right: ['IO5', 'IO6', 'IO7', 'IO8', 'IO9', 'IO10', 'IO20', 'IO21'],
    },
  },

  // ---------------------------------------------------------------- Basics
  {
    id: 'resistor', name: 'Resistor', mpn: '220R', cat: 'basics', ref: 'R', passive: true,
    full: '220 Ω 1/4 W Carbon Film Resistor (resistor assortment kit)', q: 'resistor assortment kit 1/4w',
    board: null, art: 'resistor', w: 4, h: 0, pins: { left: ['1'], right: ['2'] },
    tip: 'Put one in series with every LED so it does not burn out. 220 Ω is a good default.',
  },
  {
    id: 'button', name: 'Push button', mpn: 'TS-6x6', cat: 'basics', ref: 'SW',
    full: '6×6 mm Tactile Push Button Switch (4-leg, through hole)', q: '6x6mm tactile push button switch kit',
    board: null, art: 'button', w: 3, h: 3, pins: ['1', '2'],
    tip: 'Wire one leg to a GPIO and the other to GND. The code uses the built-in pull-up.',
    code: { glob: 'const int BUTTON[[n]]_PIN = [[ANY]];', setup: 'pinMode(BUTTON[[n]]_PIN, INPUT_PULLUP);', loop: 'if (digitalRead(BUTTON[[n]]_PIN) == LOW) Serial.println("Button [[n]] pressed");' },
  },
  {
    id: 'slideswitch', name: 'Slide switch', mpn: 'SS12D00', cat: 'basics', ref: 'SW',
    full: 'SS12D00 SPDT Mini Slide Switch (3-pin)', q: 'SS12D00 slide switch',
    board: null, art: 'slide', w: 4, h: 2, pins: ['1', 'COM', '2'],
    tip: 'An on/off switch. COM connects to pin 1 or pin 2 depending on the slider.',
  },
  {
    id: 'pot', name: 'Knob', mpn: 'B10K', cat: 'basics', ref: 'RV',
    full: '10 kΩ Linear Rotary Potentiometer (B10K) with knob', q: 'B10K potentiometer with knob',
    board: PCB.blue, art: 'pot', w: 4, h: 4, pins: ['GND', 'OUT', 'VCC'],
    tip: 'Turning the knob changes the OUT voltage. Wire OUT to an analog pin (D32–D39).',
    code: { glob: 'const int KNOB[[n]]_PIN = [[OUT]];', loop: 'Serial.printf("Knob [[n]]: %d\\n", analogRead(KNOB[[n]]_PIN));' },
  },
  {
    id: 'breadboard_psu', name: 'Breadboard power', mpn: 'MB102', cat: 'power', ref: 'U',
    full: 'MB102 Breadboard Power Supply Module (3.3 V / 5 V)', q: 'MB102 breadboard power supply module',
    board: PCB.red, art: 'chip', w: 6, h: 4, pins: ['5V', '3V3', 'GND'],
    rails: { '5V': '5V', '3V3': '3V3', GND: 'GND' },
    tip: 'Plugs into a breadboard and gives you 5 V and 3.3 V rails.',
  },

  // ---------------------------------------------------------------- Lights
  {
    id: 'led', name: 'LED', mpn: 'LED-5mm', cat: 'lights', ref: 'D', passive: true,
    full: '5 mm LED (assorted colors kit)', q: '5mm LED assorted kit',
    board: null, art: 'led', w: 3, h: 3, pins: ['+', '-'],
    tip: 'Long leg is +. Always add a resistor in series.',
    code: { glob: 'const int LED[[n]]_PIN = [[ANY]];', setup: 'pinMode(LED[[n]]_PIN, OUTPUT);', loop: 'digitalWrite(LED[[n]]_PIN, (millis() / 500) % 2); // blink' },
  },
  {
    id: 'rgbled', name: 'RGB LED', mpn: 'KY-016', cat: 'lights', ref: 'D',
    full: 'KY-016 RGB LED Module (common cathode, resistors on board)', q: 'KY-016 RGB LED module',
    board: PCB.black, art: 'led', ledColor: '#ffffff', w: 5, h: 4, pins: ['R', 'G', 'B', 'GND'],
    tip: 'Mix red, green and blue to make any color.',
    code: {
      glob: 'const int RGB[[n]]_R = [[R]], RGB[[n]]_G = [[G]], RGB[[n]]_B = [[B]];',
      setup: 'pinMode(RGB[[n]]_R, OUTPUT); pinMode(RGB[[n]]_G, OUTPUT); pinMode(RGB[[n]]_B, OUTPUT);',
      loop: 'analogWrite(RGB[[n]]_R, (millis() / 10) % 255); analogWrite(RGB[[n]]_G, 80); analogWrite(RGB[[n]]_B, 200);',
    },
  },
  {
    id: 'ledring', name: 'LED ring', mpn: 'WS2812B-16', cat: 'lights', ref: 'D',
    full: 'WS2812B 16-LED Addressable RGB Ring (NeoPixel compatible)', q: 'WS2812B 16 LED ring',
    board: PCB.black, art: 'ring', w: 5, h: 6, pins: ['5V', 'GND', 'DIN', 'DOUT'],
    tip: 'Every LED can be any color. Wire DIN to a GPIO. Needs the Adafruit NeoPixel library.',
    code: {
      inc: ['#include <Adafruit_NeoPixel.h>'],
      glob: 'Adafruit_NeoPixel ring[[n]](16, [[DIN]], NEO_GRB + NEO_KHZ800);',
      setup: 'ring[[n]].begin(); ring[[n]].setBrightness(40);',
      loop: 'for (int i = 0; i < 16; i++) ring[[n]].setPixelColor(i, ring[[n]].ColorHSV((millis() * 20 + i * 4096) & 0xFFFF));\n  ring[[n]].show();',
    },
  },
  {
    id: 'ledstrip', name: 'LED strip', mpn: 'WS2812B-strip', cat: 'lights', ref: 'D',
    full: 'WS2812B Addressable RGB LED Strip (60 LED/m, 5 V)', q: 'WS2812B LED strip 5V 60 LED',
    board: PCB.white, art: 'strip', w: 8, h: 3, pins: ['5V', 'DIN', 'GND'],
    tip: 'A strip of individually controllable LEDs. Use a separate 5 V supply for long strips.',
    code: {
      inc: ['#include <Adafruit_NeoPixel.h>'],
      glob: 'Adafruit_NeoPixel strip[[n]](30, [[DIN]], NEO_GRB + NEO_KHZ800);',
      setup: 'strip[[n]].begin(); strip[[n]].setBrightness(40);',
      loop: 'strip[[n]].rainbow((millis() * 30) & 0xFFFF); strip[[n]].show();',
    },
  },
  {
    id: 'matrix', name: 'LED grid', mpn: 'MAX7219-8x8', cat: 'lights', ref: 'U',
    full: 'MAX7219 8×8 LED Dot Matrix Module', q: 'MAX7219 8x8 LED matrix module',
    board: PCB.blue, art: 'matrix', w: 8, h: 8, pins: { left: ['VCC', 'GND', 'DIN', 'CS', 'CLK'] },
    tip: 'Draw pixels, icons or scrolling text on 64 red LEDs.',
    code: {
      inc: ['#include <MD_MAX72xx.h>'],
      glob: 'MD_MAX72XX matrix[[n]](MD_MAX72XX::GENERIC_HW, [[DIN]], [[CLK]], [[CS]], 1);',
      setup: 'matrix[[n]].begin(); matrix[[n]].control(MD_MAX72XX::INTENSITY, 4); matrix[[n]].clear();',
      loop: 'matrix[[n]].setPoint((millis() / 1600) % 8, (millis() / 200) % 8, true);',
    },
  },

  // ---------------------------------------------------------------- Sensors
  {
    id: 'hcsr04', name: 'Distance sensor', mpn: 'HC-SR04', cat: 'sensors', ref: 'U',
    full: 'HC-SR04 Ultrasonic Distance Sensor Module (2–400 cm)', q: 'HC-SR04 ultrasonic sensor',
    board: PCB.blue, art: 'ultrasonic', w: 9, h: 5, pins: ['VCC', 'TRIG', 'ECHO', 'GND'],
    tip: 'Measures distance with sound. Runs on 5 V (VIN). ECHO outputs 5 V, so add a 1k/2k voltage divider to be safe.',
    code: {
      glob: 'const int TRIG[[n]]_PIN = [[TRIG]], ECHO[[n]]_PIN = [[ECHO]];\nfloat readDistanceCm[[n]]() {\n  digitalWrite(TRIG[[n]]_PIN, LOW); delayMicroseconds(2);\n  digitalWrite(TRIG[[n]]_PIN, HIGH); delayMicroseconds(10); digitalWrite(TRIG[[n]]_PIN, LOW);\n  return pulseIn(ECHO[[n]]_PIN, HIGH, 30000) * 0.0343 / 2.0;\n}',
      setup: 'pinMode(TRIG[[n]]_PIN, OUTPUT); pinMode(ECHO[[n]]_PIN, INPUT);',
      loop: 'Serial.printf("Distance [[n]]: %.1f cm\\n", readDistanceCm[[n]]());',
    },
  },
  {
    id: 'vl53l0x', name: 'Laser distance sensor', mpn: 'VL53L0X', cat: 'sensors', ref: 'U',
    full: 'VL53L0X Time-of-Flight Laser Distance Sensor (GY-530, I2C)', q: 'VL53L0X time of flight sensor',
    board: PCB.purple, art: 'chip', w: 7, h: 4, pins: ['VIN', 'GND', 'SCL', 'SDA', 'GPIO1', 'XSHUT'],
    tip: 'Precise distance up to ~2 m with an invisible laser. Talks I2C.',
    code: {
      inc: ['#include <Wire.h>', '#include <Adafruit_VL53L0X.h>'], glob: 'Adafruit_VL53L0X lox[[n]];',
      setup: 'Wire.begin([[SDA]], [[SCL]]);\n  lox[[n]].begin();',
      loop: 'Serial.printf("Laser distance [[n]]: %d mm\\n", lox[[n]].readRange());',
    },
  },
  {
    id: 'dht22', name: 'Temp & humidity sensor', mpn: 'DHT22', cat: 'sensors', ref: 'U',
    full: 'DHT22 / AM2302 Temperature and Humidity Sensor Module', q: 'DHT22 temperature humidity sensor module',
    board: PCB.blue, art: 'grille', w: 4, h: 5, pins: ['VCC', 'DATA', 'GND'],
    tip: 'Reads air temperature and humidity every 2 seconds. Needs the DHT sensor library.',
    code: {
      inc: ['#include <DHT.h>'], glob: 'DHT dht[[n]]([[DATA]], DHT22);', setup: 'dht[[n]].begin();',
      loop: 'Serial.printf("Temp [[n]]: %.1f C  Humidity: %.0f %%\\n", dht[[n]].readTemperature(), dht[[n]].readHumidity());',
    },
  },
  {
    id: 'ds18b20', name: 'Waterproof temp probe', mpn: 'DS18B20', cat: 'sensors', ref: 'U',
    full: 'DS18B20 Waterproof Temperature Sensor Probe (1 m cable)', q: 'DS18B20 waterproof temperature probe',
    board: null, art: 'probe', w: 4, h: 3, pins: ['VCC', 'DATA', 'GND'],
    tip: 'Measures liquids or soil. Needs a 4.7 kΩ resistor between DATA and VCC.',
    code: {
      inc: ['#include <OneWire.h>', '#include <DallasTemperature.h>'],
      glob: 'OneWire oneWire[[n]]([[DATA]]);\nDallasTemperature probe[[n]](&oneWire[[n]]);', setup: 'probe[[n]].begin();',
      loop: 'probe[[n]].requestTemperatures(); Serial.printf("Probe [[n]]: %.2f C\\n", probe[[n]].getTempCByIndex(0));',
    },
  },
  {
    id: 'bme280', name: 'Weather sensor', mpn: 'BME280', cat: 'sensors', ref: 'U',
    full: 'BME280 Temperature, Humidity & Pressure Sensor (I2C)', q: 'BME280 sensor module I2C',
    board: PCB.purple, art: 'chip', w: 5, h: 4, pins: ['VIN', 'GND', 'SCL', 'SDA'],
    tip: 'Temperature, humidity and air pressure in one tiny I2C sensor.',
    code: {
      inc: ['#include <Wire.h>', '#include <Adafruit_BME280.h>'], glob: 'Adafruit_BME280 bme[[n]];',
      setup: 'Wire.begin([[SDA]], [[SCL]]);\n  bme[[n]].begin(0x76);',
      loop: 'Serial.printf("BME [[n]]: %.1f C %.0f%% %.0f hPa\\n", bme[[n]].readTemperature(), bme[[n]].readHumidity(), bme[[n]].readPressure() / 100.0);',
    },
  },
  {
    id: 'pir', name: 'Motion sensor', mpn: 'HC-SR501', cat: 'sensors', ref: 'U',
    full: 'HC-SR501 PIR Infrared Motion Sensor Module', q: 'HC-SR501 PIR motion sensor',
    board: PCB.green, art: 'dome', w: 6, h: 6, pins: ['VCC', 'OUT', 'GND'],
    tip: 'OUT goes HIGH when a person moves in front of it. Power it from VIN (5 V).',
    code: { glob: 'const int PIR[[n]]_PIN = [[OUT]];', setup: 'pinMode(PIR[[n]]_PIN, INPUT);', loop: 'if (digitalRead(PIR[[n]]_PIN)) Serial.println("Motion [[n]] detected!");' },
  },
  {
    id: 'ldr', name: 'Light sensor', mpn: 'LM393-LDR', cat: 'sensors', ref: 'U',
    full: 'Photoresistor Light Sensor Module (LM393, digital + analog)', q: 'photoresistor light sensor module LM393',
    board: PCB.blue, art: 'ldr', w: 5, h: 4, pins: ['VCC', 'GND', 'DO', 'AO'],
    tip: 'AO gives brightness as a number. DO flips at the level set by the trim pot.',
    code: { glob: 'const int LIGHT[[n]]_PIN = [[AO]];', loop: 'Serial.printf("Light [[n]]: %d\\n", analogRead(LIGHT[[n]]_PIN));' },
  },
  {
    id: 'sound', name: 'Sound sensor', mpn: 'KY-038', cat: 'sensors', ref: 'U',
    full: 'KY-038 Microphone Sound Sensor Module', q: 'KY-038 sound sensor module',
    board: PCB.red, art: 'mic', w: 5, h: 4, pins: ['AO', 'GND', 'VCC', 'DO'],
    tip: 'Detects claps and loud noises.',
    code: { glob: 'const int SOUND[[n]]_PIN = [[AO]];', loop: 'Serial.printf("Sound [[n]]: %d\\n", analogRead(SOUND[[n]]_PIN));' },
  },
  {
    id: 'soil', name: 'Soil moisture sensor', mpn: 'CSMS-v1.2', cat: 'sensors', ref: 'U',
    full: 'Capacitive Soil Moisture Sensor v1.2 (corrosion resistant)', q: 'capacitive soil moisture sensor v1.2',
    board: PCB.black, art: 'soil', w: 4, h: 9, pins: { top: ['GND', 'VCC', 'AOUT'] },
    tip: 'Stick it in a plant pot. Lower readings mean wetter soil.',
    code: { glob: 'const int SOIL[[n]]_PIN = [[AOUT]];', loop: 'Serial.printf("Soil [[n]]: %d\\n", analogRead(SOIL[[n]]_PIN));' },
  },
  {
    id: 'mq2', name: 'Gas & smoke sensor', mpn: 'MQ-2', cat: 'sensors', ref: 'U',
    full: 'MQ-2 Gas / Smoke / LPG Sensor Module', q: 'MQ-2 gas sensor module',
    board: PCB.blue, art: 'gas', w: 5, h: 5, pins: ['VCC', 'GND', 'DO', 'AO'],
    tip: 'Senses smoke and flammable gas. Needs 5 V and warms up for ~1 minute.',
    code: { glob: 'const int GAS[[n]]_PIN = [[AO]];', loop: 'Serial.printf("Gas [[n]]: %d\\n", analogRead(GAS[[n]]_PIN));' },
  },
  {
    id: 'mpu6050', name: 'Tilt & motion sensor', mpn: 'MPU-6050', cat: 'sensors', ref: 'U',
    full: 'MPU-6050 6-Axis Accelerometer + Gyroscope (GY-521)', q: 'GY-521 MPU-6050 module',
    board: PCB.blue, art: 'chip', w: 9, h: 5, pins: ['VCC', 'GND', 'SCL', 'SDA', 'XDA', 'XCL', 'AD0', 'INT'],
    tip: 'Knows which way is down and how fast it spins. Talks I2C.',
    code: {
      inc: ['#include <Wire.h>', '#include <Adafruit_MPU6050.h>'], glob: 'Adafruit_MPU6050 mpu[[n]];',
      setup: 'Wire.begin([[SDA]], [[SCL]]);\n  mpu[[n]].begin();',
      loop: 'sensors_event_t a[[n]], g[[n]], t[[n]];\n  mpu[[n]].getEvent(&a[[n]], &g[[n]], &t[[n]]);\n  Serial.printf("Accel [[n]]: %.2f %.2f %.2f\\n", a[[n]].acceleration.x, a[[n]].acceleration.y, a[[n]].acceleration.z);',
    },
  },
  {
    id: 'tcrt5000', name: 'Line / edge sensor', mpn: 'TCRT5000', cat: 'sensors', ref: 'U',
    full: 'TCRT5000 Infrared Line Tracking / Obstacle Sensor Module', q: 'TCRT5000 IR line tracking sensor module',
    board: PCB.blue, art: 'ir', w: 5, h: 5, pins: ['VCC', 'GND', 'DO', 'AO'],
    tip: 'Sees black lines or a table edge right below it.',
    code: { glob: 'const int LINE[[n]]_PIN = [[DO]];', setup: 'pinMode(LINE[[n]]_PIN, INPUT);', loop: 'Serial.printf("Line [[n]]: %d\\n", digitalRead(LINE[[n]]_PIN));' },
  },
  {
    id: 'hall', name: 'Magnet sensor', mpn: 'KY-003', cat: 'sensors', ref: 'U',
    full: 'KY-003 Hall Effect Magnetic Sensor Module', q: 'KY-003 hall effect sensor module',
    board: PCB.black, art: 'chip', w: 4, h: 4, pins: ['SIG', 'VCC', 'GND'],
    tip: 'SIG goes LOW when a magnet is near.',
    code: { glob: 'const int HALL[[n]]_PIN = [[SIG]];', setup: 'pinMode(HALL[[n]]_PIN, INPUT_PULLUP);', loop: 'if (!digitalRead(HALL[[n]]_PIN)) Serial.println("Magnet [[n]] near");' },
  },
  {
    id: 'heartrate', name: 'Heart-rate sensor', mpn: 'MAX30102', cat: 'sensors', ref: 'U',
    full: 'MAX30102 Heart-Rate & SpO2 Pulse Oximeter Sensor Module', q: 'MAX30102 heart rate sensor module',
    board: PCB.purple, art: 'chip', w: 8, h: 4, pins: ['VIN', 'SDA', 'SCL', 'INT', 'IRD', 'RD', 'GND'],
    tip: 'Put a fingertip on it to read pulse. Talks I2C.',
    code: {
      inc: ['#include <Wire.h>', '#include "MAX30105.h"'], glob: 'MAX30105 pulse[[n]];',
      setup: 'Wire.begin([[SDA]], [[SCL]]);\n  pulse[[n]].begin(Wire); pulse[[n]].setup();',
      loop: 'Serial.printf("IR [[n]]: %lu\\n", pulse[[n]].getIR());',
    },
  },
  {
    id: 'loadcell', name: 'Weight sensor', mpn: 'HX711', cat: 'sensors', ref: 'U',
    full: 'HX711 Load Cell Amplifier + 5 kg Load Cell Kit', q: 'HX711 load cell kit 5kg',
    board: PCB.green, art: 'chip', w: 7, h: 7,
    pins: { left: ['E+', 'E-', 'A-', 'A+', 'B-', 'B+'], right: ['GND', 'DT', 'SCK', 'VCC'] },
    tip: 'Turns a load cell into a kitchen scale. Load cell wires go on the left.',
    code: {
      inc: ['#include <HX711.h>'], glob: 'HX711 scale[[n]];', setup: 'scale[[n]].begin([[DT]], [[SCK]]);',
      loop: 'if (scale[[n]].is_ready()) Serial.printf("Weight raw [[n]]: %ld\\n", scale[[n]].read());',
    },
  },
  {
    id: 'gps', name: 'GPS module', mpn: 'NEO-6M', cat: 'sensors', ref: 'U',
    full: 'NEO-6M GPS Module with Ceramic Antenna (GY-GPS6MV2)', q: 'NEO-6M GPS module',
    board: PCB.blue, art: 'gps', w: 6, h: 6, pins: ['VCC', 'RX', 'TX', 'GND'],
    tip: 'Finds latitude and longitude from satellites. Works best outdoors.',
    code: {
      inc: ['#include <TinyGPSPlus.h>'], glob: 'TinyGPSPlus gps[[n]];',
      setup: 'Serial2.begin(9600, SERIAL_8N1, [[TX]], [[RX]]);',
      loop: 'while (Serial2.available()) gps[[n]].encode(Serial2.read());\n  if (gps[[n]].location.isUpdated()) Serial.printf("GPS: %.6f, %.6f\\n", gps[[n]].location.lat(), gps[[n]].location.lng());',
    },
  },

  // ---------------------------------------------------------------- Input
  {
    id: 'touch', name: 'Touch sensor', mpn: 'TTP223', cat: 'input', ref: 'U',
    full: 'TTP223 Capacitive Touch Sensor Module', q: 'TTP223 touch sensor module',
    board: PCB.red, art: 'touch', w: 4, h: 4, pins: ['GND', 'VCC', 'SIG'],
    tip: 'A button you only need to touch.',
    code: { glob: 'const int TOUCH[[n]]_PIN = [[SIG]];', setup: 'pinMode(TOUCH[[n]]_PIN, INPUT);', loop: 'if (digitalRead(TOUCH[[n]]_PIN)) Serial.println("Touched [[n]]");' },
  },
  {
    id: 'joystick', name: 'Joystick', mpn: 'KY-023', cat: 'input', ref: 'U',
    full: 'KY-023 Dual-Axis XY Joystick Module with button', q: 'KY-023 joystick module',
    board: PCB.black, art: 'joystick', w: 6, h: 6, pins: ['GND', '+5V', 'VRX', 'VRY', 'SW'],
    tip: 'Two analog axes plus a click. Wire VRX/VRY to analog pins.',
    code: {
      glob: 'const int JOY[[n]]_X = [[VRX]], JOY[[n]]_Y = [[VRY]], JOY[[n]]_SW = [[SW]];', setup: 'pinMode(JOY[[n]]_SW, INPUT_PULLUP);',
      loop: 'Serial.printf("Joystick [[n]]: x=%d y=%d click=%d\\n", analogRead(JOY[[n]]_X), analogRead(JOY[[n]]_Y), !digitalRead(JOY[[n]]_SW));',
    },
  },
  {
    id: 'encoder', name: 'Clicky knob', mpn: 'KY-040', cat: 'input', ref: 'U',
    full: 'KY-040 Rotary Encoder Module with push button', q: 'KY-040 rotary encoder module',
    board: PCB.blue, art: 'pot', w: 6, h: 5, pins: ['CLK', 'DT', 'SW', '+', 'GND'],
    tip: 'Spins forever in clicks, like a volume knob on a car stereo.',
    code: {
      glob: 'const int ENC[[n]]_CLK = [[CLK]], ENC[[n]]_DT = [[DT]];\nint enc[[n]]Count = 0, enc[[n]]Last = HIGH;',
      setup: 'pinMode(ENC[[n]]_CLK, INPUT_PULLUP); pinMode(ENC[[n]]_DT, INPUT_PULLUP);',
      loop: 'int clk[[n]] = digitalRead(ENC[[n]]_CLK);\n  if (clk[[n]] != enc[[n]]Last && clk[[n]] == LOW) { enc[[n]]Count += digitalRead(ENC[[n]]_DT) ? 1 : -1; Serial.printf("Knob [[n]]: %d\\n", enc[[n]]Count); }\n  enc[[n]]Last = clk[[n]];',
    },
  },
  {
    id: 'keypad', name: 'Keypad', mpn: 'Keypad-4x4', cat: 'input', ref: 'U',
    full: '4×4 Matrix Membrane Keypad (16 keys)', q: '4x4 matrix membrane keypad',
    board: PCB.black, art: 'keypad', w: 9, h: 10, pins: ['R1', 'R2', 'R3', 'R4', 'C1', 'C2', 'C3', 'C4'],
    tip: 'Type numbers and letters A–D. Needs 8 GPIOs and the Keypad library.',
    code: {
      inc: ['#include <Keypad.h>'],
      glob: 'char keys[[n]][4][4] = {{\'1\',\'2\',\'3\',\'A\'},{\'4\',\'5\',\'6\',\'B\'},{\'7\',\'8\',\'9\',\'C\'},{\'*\',\'0\',\'#\',\'D\'}};\nbyte rowPins[[n]][4] = {[[R1]], [[R2]], [[R3]], [[R4]]};\nbyte colPins[[n]][4] = {[[C1]], [[C2]], [[C3]], [[C4]]};\nKeypad keypad[[n]] = Keypad(makeKeymap(keys[[n]]), rowPins[[n]], colPins[[n]], 4, 4);',
      loop: 'char key[[n]] = keypad[[n]].getKey();\n  if (key[[n]]) Serial.printf("Key: %c\\n", key[[n]]);',
    },
  },
  {
    id: 'irrecv', name: 'IR remote receiver', mpn: 'VS1838B', cat: 'input', ref: 'U',
    full: 'VS1838B IR Receiver Module + Remote Control Kit', q: 'VS1838B IR receiver remote kit',
    board: PCB.black, art: 'ir', w: 4, h: 4, pins: ['SIG', 'VCC', 'GND'],
    tip: 'Reads button presses from a TV-style remote.',
    code: {
      inc: ['#include <IRremote.hpp>'], setup: 'IrReceiver.begin([[SIG]]);',
      loop: 'if (IrReceiver.decode()) { Serial.printf("IR code: 0x%X\\n", IrReceiver.decodedIRData.command); IrReceiver.resume(); }',
    },
  },
  {
    id: 'rfid', name: 'RFID card reader', mpn: 'RC522', cat: 'input', ref: 'U',
    full: 'RC522 13.56 MHz RFID Reader Module with card and key fob', q: 'RC522 RFID module kit',
    board: PCB.blue, art: 'rfid', w: 9, h: 10, pins: ['SDA', 'SCK', 'MOSI', 'MISO', 'IRQ', 'GND', 'RST', '3.3V'],
    tip: 'Reads key fobs and cards. 3.3 V only!',
    code: {
      inc: ['#include <SPI.h>', '#include <MFRC522.h>'], glob: 'MFRC522 rfid[[n]]([[SDA]], [[RST]]);',
      setup: 'SPI.begin([[SCK]], [[MISO]], [[MOSI]], [[SDA]]);\n  rfid[[n]].PCD_Init();',
      loop: 'if (rfid[[n]].PICC_IsNewCardPresent() && rfid[[n]].PICC_ReadCardSerial()) { Serial.print("Card UID:"); for (byte i = 0; i < rfid[[n]].uid.size; i++) Serial.printf(" %02X", rfid[[n]].uid.uidByte[i]); Serial.println(); }',
    },
  },

  // ---------------------------------------------------------------- Screens
  {
    id: 'oled', name: 'Small screen', mpn: 'SSD1306-0.96', cat: 'screens', ref: 'U',
    full: '0.96" SSD1306 128×64 I2C OLED Display', q: '0.96 inch OLED SSD1306 I2C',
    board: PCB.blue, art: 'oled', w: 11, h: 9, pins: { top: ['GND', 'VCC', 'SCL', 'SDA'] },
    tip: 'Crisp little screen for text and drawings. Talks I2C.',
    code: {
      inc: ['#include <Wire.h>', '#include <Adafruit_GFX.h>', '#include <Adafruit_SSD1306.h>'],
      glob: 'Adafruit_SSD1306 oled[[n]](128, 64, &Wire, -1);',
      setup: 'Wire.begin([[SDA]], [[SCL]]);\n  oled[[n]].begin(SSD1306_SWITCHCAPVCC, 0x3C);\n  oled[[n]].setTextColor(SSD1306_WHITE);',
      loop: 'oled[[n]].clearDisplay(); oled[[n]].setTextSize(2); oled[[n]].setCursor(0, 20);\n  oled[[n]].printf("GFLUX %lus", millis() / 1000); oled[[n]].display();',
    },
  },
  {
    id: 'lcd', name: 'Text screen', mpn: 'LCD1602-I2C', cat: 'screens', ref: 'U',
    full: '16×2 LCD1602 Display with I2C Backpack (PCF8574)', q: 'LCD1602 I2C module',
    board: PCB.green, art: 'lcd', w: 16, h: 7, pins: { left: ['GND', 'VCC', 'SDA', 'SCL'] },
    tip: 'Two lines of 16 characters. Power it from VIN (5 V).',
    code: {
      inc: ['#include <Wire.h>', '#include <LiquidCrystal_I2C.h>'], glob: 'LiquidCrystal_I2C lcd[[n]](0x27, 16, 2);',
      setup: 'Wire.begin([[SDA]], [[SCL]]);\n  lcd[[n]].init(); lcd[[n]].backlight(); lcd[[n]].print("Hello GFLUX!");',
      loop: 'lcd[[n]].setCursor(0, 1); lcd[[n]].printf("Up %lus   ", millis() / 1000);',
    },
  },
  {
    id: 'tm1637', name: 'Number display', mpn: 'TM1637', cat: 'screens', ref: 'U',
    full: 'TM1637 4-Digit 7-Segment LED Display Module', q: 'TM1637 4 digit display module',
    board: PCB.blue, art: 'seg', w: 11, h: 5, pins: { right: ['CLK', 'DIO', 'VCC', 'GND'] },
    tip: 'Shows 4 big digits, great for clocks and counters.',
    code: {
      inc: ['#include <TM1637Display.h>'], glob: 'TM1637Display digits[[n]]([[CLK]], [[DIO]]);',
      setup: 'digits[[n]].setBrightness(4);', loop: 'digits[[n]].showNumberDec((millis() / 1000) % 10000);',
    },
  },

  // ---------------------------------------------------------------- Motors
  {
    id: 'servo', name: 'Servo motor', mpn: 'SG90', cat: 'motors', ref: 'M',
    full: 'SG90 9 g Micro Servo Motor (180°)', q: 'SG90 micro servo',
    board: null, art: 'servo', w: 6, h: 5, pins: ['GND', 'VCC', 'SIG'],
    tip: 'Turns to an exact angle. Brown = GND, red = 5 V, orange = signal.',
    code: {
      inc: ['#include <ESP32Servo.h>'], glob: 'Servo servo[[n]];', setup: 'servo[[n]].attach([[SIG]]);',
      loop: 'servo[[n]].write((millis() / 20) % 180);',
    },
  },
  {
    id: 'dcmotor', name: 'DC motor', mpn: 'TT-motor', cat: 'motors', ref: 'M', passive: true,
    full: 'TT Gear Motor 3–6 V (robot car motor)', q: 'TT gear motor 3-6V',
    board: null, art: 'motor', w: 6, h: 4, pins: ['M+', 'M-'],
    tip: 'Never wire a motor straight to the ESP32. Drive it through a motor driver.',
  },
  {
    id: 'l298n', name: 'Motor driver', mpn: 'L298N', cat: 'motors', ref: 'U',
    full: 'L298N Dual H-Bridge DC Motor Driver Module', q: 'L298N motor driver module',
    board: PCB.red, art: 'heatsink', w: 10, h: 9,
    pins: { left: ['OUT1', 'OUT2'], right: ['OUT3', 'OUT4'], bottom: ['12V', 'GND', '5V', 'ENA', 'IN1', 'IN2', 'IN3', 'IN4', 'ENB'] },
    tip: 'Lets the ESP32 drive two DC motors forwards and backwards.',
    code: {
      glob: 'const int MD[[n]]_ENA = [[ENA]], MD[[n]]_IN1 = [[IN1]], MD[[n]]_IN2 = [[IN2]];',
      setup: 'pinMode(MD[[n]]_ENA, OUTPUT); pinMode(MD[[n]]_IN1, OUTPUT); pinMode(MD[[n]]_IN2, OUTPUT);',
      loop: 'digitalWrite(MD[[n]]_IN1, HIGH); digitalWrite(MD[[n]]_IN2, LOW); analogWrite(MD[[n]]_ENA, 180); // motor A forward',
    },
  },
  {
    id: 'stepper', name: 'Stepper motor', mpn: '28BYJ-48+ULN2003', cat: 'motors', ref: 'M',
    full: '28BYJ-48 5 V Stepper Motor with ULN2003 Driver Board', q: '28BYJ-48 stepper motor ULN2003',
    board: PCB.green, art: 'chip', w: 8, h: 6, pins: ['IN1', 'IN2', 'IN3', 'IN4', '+', '-'],
    tip: 'Moves in tiny precise steps. 2048 steps = one full turn.',
    code: {
      inc: ['#include <Stepper.h>'], glob: 'Stepper stepper[[n]](2048, [[IN1]], [[IN3]], [[IN2]], [[IN4]]);',
      setup: 'stepper[[n]].setSpeed(10);', loop: 'stepper[[n]].step(64);',
    },
  },
  {
    id: 'relay', name: 'Relay', mpn: 'SRD-05VDC', cat: 'motors', ref: 'K',
    full: '5 V 1-Channel Relay Module with Optocoupler', q: '5V 1 channel relay module',
    board: PCB.blue, art: 'relay', w: 9, h: 5, pins: { left: ['NO', 'COM', 'NC'], right: ['VCC', 'GND', 'IN'] },
    tip: 'A switch the ESP32 can flip to turn bigger things on and off. Mains voltage is NOT a beginner project.',
    code: { glob: 'const int RELAY[[n]]_PIN = [[IN]];', setup: 'pinMode(RELAY[[n]]_PIN, OUTPUT);', loop: 'digitalWrite(RELAY[[n]]_PIN, (millis() / 2000) % 2);' },
  },
  {
    id: 'vibe', name: 'Vibration motor', mpn: 'VIB-1027', cat: 'motors', ref: 'M',
    full: 'Vibration Motor Module (coin motor, with driver)', q: 'vibration motor module arduino',
    board: PCB.black, art: 'coin', w: 4, h: 4, pins: ['IN', 'VCC', 'GND'],
    tip: 'Buzzes like a phone in your pocket.',
    code: { glob: 'const int VIBE[[n]]_PIN = [[IN]];', setup: 'pinMode(VIBE[[n]]_PIN, OUTPUT);', loop: 'digitalWrite(VIBE[[n]]_PIN, (millis() / 1000) % 2);' },
  },

  // ---------------------------------------------------------------- Sound & storage
  {
    id: 'buzzer', name: 'Buzzer', mpn: 'KY-012', cat: 'sound', ref: 'BZ',
    full: 'KY-012 Active Buzzer Module', q: 'active buzzer module',
    board: PCB.black, art: 'buzzer', w: 4, h: 4, pins: ['SIG', 'VCC', 'GND'],
    tip: 'Beeps when SIG is HIGH.',
    code: { glob: 'const int BUZZER[[n]]_PIN = [[SIG]];', setup: 'pinMode(BUZZER[[n]]_PIN, OUTPUT);', loop: 'digitalWrite(BUZZER[[n]]_PIN, (millis() / 300) % 2);' },
  },
  {
    id: 'speaker', name: 'Speaker', mpn: 'SPK-3W-4R', cat: 'sound', ref: 'LS', passive: true,
    full: '3 W 4 Ω Mini Speaker (40 mm)', q: '3W 4 ohm mini speaker',
    board: null, art: 'speaker', w: 5, h: 5, pins: ['+', '-'],
    tip: 'Needs an amplifier or the MP3 player to make sound.',
  },
  {
    id: 'i2samp', name: 'Speaker amp', mpn: 'MAX98357A', cat: 'sound', ref: 'U',
    full: 'MAX98357A I2S 3 W Class-D Amplifier Breakout', q: 'MAX98357A I2S amplifier',
    board: PCB.purple, art: 'chip', w: 8, h: 4, pins: ['LRC', 'BCLK', 'DIN', 'GAIN', 'SD', 'GND', 'VIN'],
    tip: 'Plays digital audio from the ESP32 on a small speaker.',
  },
  {
    id: 'dfplayer', name: 'MP3 player', mpn: 'DFPlayer-Mini', cat: 'sound', ref: 'U',
    full: 'DFPlayer Mini MP3 Player Module (microSD)', q: 'DFPlayer Mini MP3 module',
    board: PCB.blue, art: 'sd', w: 8, h: 9,
    pins: {
      left: ['VCC', 'RX', 'TX', 'DAC_R', 'DAC_L', 'SPK_1', 'GND', 'SPK_2'],
      right: ['BUSY', 'USB-', 'USB+', 'ADKEY_2', 'ADKEY_1', 'IO_2', 'GND', 'IO_1'],
    },
    tip: 'Plays MP3 files from a microSD card straight to a speaker. Put a 1 kΩ resistor in the RX line.',
    code: {
      inc: ['#include <DFRobotDFPlayerMini.h>'], glob: 'DFRobotDFPlayerMini mp3[[n]];',
      setup: 'Serial2.begin(9600, SERIAL_8N1, [[TX]], [[RX]]);\n  if (mp3[[n]].begin(Serial2)) { mp3[[n]].volume(20); mp3[[n]].play(1); }',
    },
  },
  {
    id: 'sdcard', name: 'SD card module', mpn: 'MicroSD-SPI', cat: 'sound', ref: 'U',
    full: 'MicroSD Card SPI Reader Module', q: 'micro SD card module SPI',
    board: PCB.blue, art: 'sd', w: 7, h: 9, pins: ['GND', 'VCC', 'MISO', 'MOSI', 'SCK', 'CS'],
    tip: 'Save data logs or read files.',
    code: {
      inc: ['#include <SPI.h>', '#include <SD.h>'],
      setup: 'SPI.begin([[SCK]], [[MISO]], [[MOSI]], [[CS]]);\n  if (!SD.begin([[CS]])) Serial.println("SD card not found");',
    },
  },
  {
    id: 'rtc', name: 'Clock module', mpn: 'DS3231', cat: 'sound', ref: 'U',
    full: 'DS3231 Real-Time Clock Module (with coin cell holder)', q: 'DS3231 RTC module',
    board: PCB.blue, art: 'coin', w: 10, h: 6, pins: { right: ['32K', 'SQW', 'SCL', 'SDA', 'VCC', 'GND'] },
    tip: 'Keeps the time even when unplugged.',
    code: {
      inc: ['#include <Wire.h>', '#include <RTClib.h>'], glob: 'RTC_DS3231 rtc[[n]];',
      setup: 'Wire.begin([[SDA]], [[SCL]]);\n  rtc[[n]].begin();',
      loop: 'DateTime now[[n]] = rtc[[n]].now();\n  Serial.printf("%02d:%02d:%02d\\n", now[[n]].hour(), now[[n]].minute(), now[[n]].second());',
    },
  },

  // ---------------------------------------------------------------- Power
  {
    id: 'battery', name: 'Battery pack', mpn: '4xAA', cat: 'power', ref: 'BT', passive: true,
    full: '4×AA Battery Holder with On/Off Switch (6 V)', q: '4 AA battery holder with switch',
    board: null, art: 'battery', w: 8, h: 5, pins: ['+', '-'],
    rails: { '+': 'VBAT', '-': 'GND' },
    tip: 'Portable power. Wire + to VIN and - to GND.',
  },
  {
    id: 'tp4056', name: 'Battery charger', mpn: 'TP4056', cat: 'power', ref: 'U',
    full: 'TP4056 USB-C Li-ion Battery Charger Module (with protection)', q: 'TP4056 USB-C charger module',
    board: PCB.blue, art: 'chip', w: 7, h: 5, pins: { left: ['IN+', 'IN-'], right: ['B+', 'B-', 'OUT+', 'OUT-'] },
    rails: { 'OUT+': 'VBAT', 'OUT-': 'GND', 'IN-': 'GND' },
    tip: 'Charges a single 3.7 V lithium cell from USB.',
  },
  {
    id: 'buck', name: 'Power regulator', mpn: 'LM2596', cat: 'power', ref: 'U',
    full: 'LM2596 Adjustable DC-DC Buck Converter Module', q: 'LM2596 buck converter module',
    board: PCB.blue, art: 'buck', w: 10, h: 5, pins: { left: ['IN+', 'IN-'], right: ['OUT+', 'OUT-'] },
    rails: { 'OUT+': 'VREG', 'OUT-': 'GND', 'IN-': 'GND' },
    tip: 'Turns 7–35 V down to the voltage you set with the screw.',
  },
];

// ------------------------------------------------------------------ layout

/** Pin role used for wire colours and KiCad pin types. */
GFLUX.pinKind = function (name) {
  const n = String(name).toUpperCase();
  if (/^(GND|G|-|M-|B-|IN-|OUT-|USB-)$/.test(n) || n === 'GND') return 'gnd';
  if (/^(3V3|3\.3V)$/.test(n)) return 'v3';
  if (/^(VCC|VIN|5V|\+5V|12V|\+|M\+|B\+|IN\+|OUT\+|DC\+)$/.test(n)) return 'v5';
  if (n === 'SDA') return 'sda';
  if (n === 'SCL') return 'scl';
  return 'sig';
};

function fitSpan(min, n) {
  if (!n) return min;
  let v = Math.max(min, n + 1);
  if ((v - (n - 1)) % 2) v++;
  return v;
}

/** Turn a part definition into concrete geometry (w, h, pins with local positions). */
GFLUX.layout = function (def) {
  const sides = Array.isArray(def.pins) ? { bottom: def.pins } : def.pins;
  const L = sides.left || [], R = sides.right || [], T = sides.top || [], B = sides.bottom || [];
  const w = fitSpan(def.w || 4, Math.max(T.length, B.length));
  const h = def.h === 0 && !T.length && !B.length && Math.max(L.length, R.length) <= 1
    ? 0 : fitSpan(def.h || 3, Math.max(L.length, R.length));
  const pins = [];
  let num = 1;
  const place = (list, side) => {
    const span = side === 'left' || side === 'right' ? h : w;
    const start = Math.floor((span - (list.length - 1)) / 2);
    list.forEach((name, i) => {
      const t = start + i;
      const p = { name, side, num: String(num++), kind: GFLUX.pinKind(name) };
      if (side === 'left') { p.x = 0; p.y = t; }
      if (side === 'right') { p.x = w; p.y = t; }
      if (side === 'top') { p.x = t; p.y = 0; }
      if (side === 'bottom') { p.x = t; p.y = h; }
      pins.push(p);
    });
  };
  for (const side of Object.keys(sides)) place(sides[side], side);
  return { w, h, pins };
};

GFLUX.amazonUrl = (def) => def.url || 'https://www.amazon.com/s?k=' + encodeURIComponent(def.q || def.full || def.name);

const cache = new Map();
GFLUX.customParts = [];

/** Look up a part definition (built-in or user-created) with its geometry. */
GFLUX.getPart = function (id) {
  if (cache.has(id)) return cache.get(id);
  const def = GFLUX.PARTS.find((p) => p.id === id) || GFLUX.customParts.find((p) => p.id === id);
  if (!def) return null;
  const built = Object.assign({}, def, GFLUX.layout(def));
  cache.set(id, built);
  return built;
};

GFLUX.allParts = () => GFLUX.PARTS.concat(GFLUX.customParts);

GFLUX.setCustomParts = function (list) {
  for (const p of GFLUX.customParts) cache.delete(p.id);
  GFLUX.customParts = (list || []).map((p) => Object.assign({ cat: 'custom', ref: 'U', board: PCB.green, art: 'chip' }, p));
  for (const p of GFLUX.customParts) cache.delete(p.id);
};

GFLUX.PCB_COLORS = PCB;
