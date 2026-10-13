import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { AcState, DaikinClient } from './client.js';
import type { DaikinLocalPlatform } from './platform.js';

export interface DeviceConfig {
  name?: string;
  ip: string;
  key: string;
  minTemp?: number;
  maxTemp?: number;
  outdoorSensor?: boolean;
}

// Device codes (see WRITEUP.md §4).
const MODE = { AUTO: 0, DRY: 2, COOL: 3, HEAT: 4, FAN: 6 } as const;
const FAN_MIN = 3; // low; 7 = high, 17 = auto, 18 = quiet
const FAN_MAX = 7;
const OUT_TEMP_INVALID = 255;
const WRITE_DEBOUNCE_MS = 250;
const REFRESH_AFTER_WRITE_MS = 3000;

export class DaikinAccessory {
  private readonly hc: Service;
  private readonly outdoor?: Service;
  private state: AcState = {};
  private lastOutTemp = 0;
  private pending: Partial<AcState> = {};
  private writeTimer?: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;
  private pollTimer?: NodeJS.Timeout;
  private writing = false;
  private reachable = true;
  private readonly minTemp: number;
  private readonly maxTemp: number;

  constructor(
    private readonly platform: DaikinLocalPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly client: DaikinClient,
    config: DeviceConfig,
    pollIntervalS: number,
  ) {
    const { Service: S, Characteristic: C } = platform;
    this.minTemp = config.minTemp ?? 16;
    this.maxTemp = config.maxTemp ?? 30;

    accessory.getService(S.AccessoryInformation)!
      .setCharacteristic(C.Manufacturer, 'Daikin')
      .setCharacteristic(C.Model, 'Smart AC (iotalabs)')
      .setCharacteristic(C.SerialNumber, config.ip);

    this.hc = accessory.getService(S.HeaterCooler) ?? accessory.addService(S.HeaterCooler);
    this.hc.setCharacteristic(C.Name, accessory.displayName);

    this.hc.getCharacteristic(C.Active)
      .onGet(() => (this.state.power ? C.Active.ACTIVE : C.Active.INACTIVE))
      .onSet((v) => this.queue({ power: v === C.Active.ACTIVE ? 1 : 0 }));

    this.hc.getCharacteristic(C.CurrentHeaterCoolerState)
      .onGet(() => this.currentHcState());

    this.hc.getCharacteristic(C.TargetHeaterCoolerState)
      .onGet(() => this.targetHcState())
      .onSet((v) => {
        const mode = v === C.TargetHeaterCoolerState.COOL ? MODE.COOL
          : v === C.TargetHeaterCoolerState.HEAT ? MODE.HEAT : MODE.AUTO;
        this.queue({ mode });
      });

    this.hc.getCharacteristic(C.CurrentTemperature)
      .onGet(() => this.state.sensors?.room_temp ?? 0);

    const tempProps = { minValue: this.minTemp, maxValue: this.maxTemp, minStep: 0.5 };
    for (const ch of [C.CoolingThresholdTemperature, C.HeatingThresholdTemperature]) {
      this.hc.getCharacteristic(ch)
        .updateValue(this.minTemp) // HAP's default (0/10) would be out of range for setProps
        .setProps(tempProps)
        .onGet(() => this.setpoint())
        .onSet((v) => this.queue({ temperature: Number(v) }));
    }

    this.hc.getCharacteristic(C.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 20 })
      .onGet(() => this.rotationSpeed())
      .onSet((v) => {
        const speed = Number(v);
        if (speed > 0) { // 0 comes with Active=0 when the slider is dragged to off
          this.queue({ fan: Math.min(FAN_MAX, Math.max(FAN_MIN, FAN_MIN - 1 + Math.round(speed / 20))) });
        }
      });

    this.hc.getCharacteristic(C.SwingMode)
      .onGet(() => (this.state.v_swing ? C.SwingMode.SWING_ENABLED : C.SwingMode.SWING_DISABLED))
      .onSet((v) => this.queue({ v_swing: v === C.SwingMode.SWING_ENABLED ? 1 : 0 }));

    const outdoorName = `${accessory.displayName} Outdoor`;
    const existingOutdoor = accessory.getService(S.TemperatureSensor);
    if (config.outdoorSensor === false) {
      if (existingOutdoor) {
        accessory.removeService(existingOutdoor);
      }
    } else {
      this.outdoor = existingOutdoor ?? accessory.addService(S.TemperatureSensor, outdoorName, 'outdoor');
      this.outdoor.setCharacteristic(C.Name, outdoorName);
      this.outdoor.getCharacteristic(C.CurrentTemperature)
        .setProps({ minValue: -50, maxValue: 100 })
        .onGet(() => this.lastOutTemp);
    }

    void this.poll();
    this.pollTimer = setInterval(() => void this.poll(), pollIntervalS * 1000);
  }

  stop(): void {
    clearInterval(this.pollTimer);
    clearTimeout(this.writeTimer);
    clearTimeout(this.refreshTimer);
  }

  // ---- state mapping ------------------------------------------------------

  private setpoint(): number {
    const t = this.state.temperature ?? this.minTemp;
    return Math.min(this.maxTemp, Math.max(this.minTemp, t));
  }

  private rotationSpeed(): number {
    const fan = this.state.fan ?? FAN_MIN;
    // auto (17) / quiet (18) have no slot on the slider; show them as the lowest step.
    if (fan < FAN_MIN || fan > FAN_MAX) {
      return 20;
    }
    return (fan - FAN_MIN + 1) * 20;
  }

  private targetHcState(): number {
    const T = this.platform.Characteristic.TargetHeaterCoolerState;
    switch (this.state.mode) {
      case MODE.COOL: return T.COOL;
      case MODE.HEAT: return T.HEAT;
      default: return T.AUTO; // auto, plus dry/fan which HomeKit cannot represent
    }
  }

  private currentHcState(): number {
    const Cur = this.platform.Characteristic.CurrentHeaterCoolerState;
    if (!this.state.power) {
      return Cur.INACTIVE;
    }
    switch (this.state.mode) {
      case MODE.COOL: return Cur.COOLING;
      case MODE.HEAT: return Cur.HEATING;
      case MODE.AUTO: {
        const room = this.state.sensors?.room_temp;
        const set = this.state.temperature;
        if (room === undefined || set === undefined) {
          return Cur.IDLE;
        }
        return room > set + 0.5 ? Cur.COOLING : room < set - 0.5 ? Cur.HEATING : Cur.IDLE;
      }
      default: return Cur.IDLE;
    }
  }

  private push(): void {
    const C = this.platform.Characteristic;
    this.hc.updateCharacteristic(C.Active, this.state.power ? C.Active.ACTIVE : C.Active.INACTIVE);
    this.hc.updateCharacteristic(C.CurrentHeaterCoolerState, this.currentHcState());
    this.hc.updateCharacteristic(C.TargetHeaterCoolerState, this.targetHcState());
    if (this.state.sensors?.room_temp !== undefined) {
      this.hc.updateCharacteristic(C.CurrentTemperature, this.state.sensors.room_temp);
    }
    this.hc.updateCharacteristic(C.CoolingThresholdTemperature, this.setpoint());
    this.hc.updateCharacteristic(C.HeatingThresholdTemperature, this.setpoint());
    this.hc.updateCharacteristic(C.RotationSpeed, this.rotationSpeed());
    this.hc.updateCharacteristic(C.SwingMode, this.state.v_swing ? C.SwingMode.SWING_ENABLED : C.SwingMode.SWING_DISABLED);

    if (this.outdoor) {
      const out = this.state.sensors?.out_temp;
      const valid = out !== undefined && out !== OUT_TEMP_INVALID;
      if (valid) {
        this.lastOutTemp = out;
        this.outdoor.updateCharacteristic(C.CurrentTemperature, out);
      }
      this.outdoor.updateCharacteristic(C.StatusActive, valid);
    }

    if (this.state.fw_ver) {
      this.accessory.getService(this.platform.Service.AccessoryInformation)!
        .updateCharacteristic(C.FirmwareRevision, String(this.state.fw_ver).replace(/^[^\d]*/, ''));
    }
  }

  private apply(next: AcState | undefined): void {
    if (next && typeof next === 'object') {
      this.state = { ...this.state, ...next, sensors: { ...this.state.sensors, ...next.sensors } };
    }
    this.push();
  }

  // ---- I/O ----------------------------------------------------------------

  private async poll(): Promise<void> {
    if (this.writing || Object.keys(this.pending).length) {
      return; // don't overwrite optimistic values while a write is in flight
    }
    try {
      this.apply(await this.client.getState());
      if (!this.reachable) {
        this.platform.log.info(`${this.accessory.displayName}: reachable again`);
      }
      this.reachable = true;
      this.platform.log.debug(`${this.accessory.displayName}: ${JSON.stringify(this.state)}`);
    } catch (err) {
      if (this.reachable) {
        this.platform.log.warn(`${this.accessory.displayName}: poll failed: ${(err as Error).message}`);
      }
      this.reachable = false;
    }
  }

  /** HomeKit sends Active/mode/temperature as separate sets in quick succession; merge them into one POST. */
  private queue(change: Partial<AcState>): void {
    this.pending = { ...this.pending, ...change };
    this.state = { ...this.state, ...change }; // optimistic
    clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => void this.flush(), WRITE_DEBOUNCE_MS);
  }

  private async flush(): Promise<void> {
    const desired = this.pending;
    this.pending = {};
    if (!Object.keys(desired).length) {
      return;
    }
    this.writing = true;
    try {
      this.platform.log.info(`${this.accessory.displayName}: set ${JSON.stringify(desired)}`);
      this.apply(await this.client.setState(desired));
    } catch (err) {
      this.platform.log.warn(`${this.accessory.displayName}: set failed: ${(err as Error).message}`);
    } finally {
      this.writing = false;
    }
    // The unit may take a moment to settle (e.g. sensors); re-read shortly after.
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.poll(), REFRESH_AFTER_WRITE_MS);
  }
}
