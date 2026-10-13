import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';
import { DaikinAccessory, type DeviceConfig } from './accessory.js';
import { DaikinClient } from './client.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

export class DaikinLocalPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  private readonly cached = new Map<string, PlatformAccessory>();
  private readonly handlers: DaikinAccessory[] = [];

  constructor(public readonly log: Logging, public readonly config: PlatformConfig, public readonly api: API) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    api.on('didFinishLaunching', () => this.setupDevices());
    api.on('shutdown', () => this.handlers.forEach((h) => h.stop()));
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory);
  }

  private setupDevices(): void {
    const devices = (this.config.devices ?? []) as DeviceConfig[];
    const pollInterval = Math.max(5, Number(this.config.pollInterval ?? 30));
    const active = new Set<string>();

    for (const dev of devices) {
      if (!dev.ip || !dev.key) {
        this.log.error(`Skipping device "${dev.name ?? '?'}": "ip" and "key" are required.`);
        continue;
      }
      let client: DaikinClient;
      try {
        client = new DaikinClient(dev.ip, dev.key);
      } catch (err) {
        this.log.error(`Skipping device "${dev.name ?? dev.ip}": ${(err as Error).message}`);
        continue;
      }

      const uuid = this.api.hap.uuid.generate(`daikin-local:${dev.ip}`);
      active.add(uuid);
      let accessory = this.cached.get(uuid);
      if (!accessory) {
        accessory = new this.api.platformAccessory(dev.name || 'Daikin AC', uuid);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.log.info(`Added ${accessory.displayName} (${dev.ip})`);
      }
      accessory.context.device = dev;
      this.handlers.push(new DaikinAccessory(this, accessory, client, dev, pollInterval));
    }

    const stale = [...this.cached.values()].filter((a) => !active.has(a.UUID));
    if (stale.length) {
      this.log.info(`Removing ${stale.length} accessory(ies) no longer in config`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  }
}
