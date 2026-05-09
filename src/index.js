import https from 'https';
import { randomUUID } from 'crypto';

const PLUGIN_NAME    = 'homebridge-inim-cloud';
const PLATFORM_NAME  = 'InimCloud';
const INIM_HOST      = 'api.inimcloud.com';
const INIM_HEADERS   = {
  'Host': 'api.inimcloud.com',
  'Accept': '*/*',
  'Accept-Language': 'it-it',
  'Accept-Encoding': 'identity',
  'User-Agent': 'Inim Home/5 CFNetwork/1329 Darwin/21.3.0',
};
const TOKEN_EXPIRED  = new Set([2, 18, 19, 20, 27]);

// HomeKit state values
const CURRENT = { STAY: 0, NIGHT: 1, AWAY: 2, DISARMED: 3, ALARM: 4 };
const TARGET   = { STAY: 0, NIGHT: 1, AWAY: 2, DISARM: 3 };

export default (homebridge) => {
  homebridge.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, InimPlatform);
};

class InimPlatform {
  constructor(log, config, api) {
    this.log       = log;
    this.config    = config;
    this.api       = api;
    this.accessory = null;

    if (!config.email || !config.password || !config.userCode) {
      this.log.error('Configurazione incompleta: email, password e PIN sono obbligatori.');
      return;
    }

    // Avvia quando Homebridge è pronto
    this.api.on('didFinishLaunching', () => this.init());
  }

  // Homebridge chiama questo metodo per gli accessori cached
  configureAccessory(accessory) {
    this.log('Ripristino accessorio cached:', accessory.displayName);
    this.accessory = accessory;
  }

  async init() {
    const { Service, Characteristic } = this.api.hap;
    const uuid = this.api.hap.uuid.generate(PLUGIN_NAME + ':alarm');
    const name = this.config.accessoryName || 'Allarme Casa';

    // Crea o riusa accessorio
    if (!this.accessory) {
      this.log('Creazione nuovo accessorio:', name);
      this.accessory = new this.api.platformAccessory(name, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [this.accessory]);
    }

    // Info service
    this.accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'INIM Electronics')
      .setCharacteristic(Characteristic.Model, 'Prime Cloud')
      .setCharacteristic(Characteristic.FirmwareRevision, '1.1.0');

    // Security System service
    let secService = this.accessory.getService(Service.SecuritySystem);
    if (!secService) {
      secService = this.accessory.addService(Service.SecuritySystem, name);
    }
    this.secService = secService;

    // Mappatura scenari
    const cfg = this.config;
    this.scenarios = {
      disarmed: cfg.scenarioDisarmed ?? 0,
      home:     cfg.scenarioHome     ?? 1,
      night:    cfg.scenarioNight    ?? 2,
      away:     cfg.scenarioAway     ?? 3,
    };
    this.scenarioToState = {
      [this.scenarios.disarmed]: CURRENT.DISARMED,
      [this.scenarios.home]:     CURRENT.STAY,
      [this.scenarios.night]:    CURRENT.NIGHT,
      [this.scenarios.away]:     CURRENT.AWAY,
    };
    this.targetToScenario = {
      [TARGET.DISARM]: this.scenarios.disarmed,
      [TARGET.STAY]:   this.scenarios.home,
      [TARGET.NIGHT]:  this.scenarios.night,
      [TARGET.AWAY]:   this.scenarios.away,
    };
    this.targetToMode = {
      [TARGET.DISARM]: 3,
      [TARGET.STAY]:   0,
      [TARGET.NIGHT]:  0,
      [TARGET.AWAY]:   0,
    };

    // Stato runtime
    this.clientId     = 'hb-' + randomUUID();
    this.token        = null;
    this.deviceId     = null;
    this.pollInterval = (cfg.pollInterval ?? 15) * 1000;
    this._pollTimer   = null;
    this.currentState = CURRENT.DISARMED;
    this.targetState  = TARGET.DISARM;

    // Handler HomeKit
    secService
      .getCharacteristic(Characteristic.SecuritySystemCurrentState)
      .onGet(() => this.currentState);
    secService
      .getCharacteristic(Characteristic.SecuritySystemTargetState)
      .onGet(() => this.targetState)
      .onSet((value) => this.handleSet(value));

    // Avvio
    await this.start();
  }

  // --- Avvio e polling ---

  async start() {
    try {
      await this.authenticate();
      await this.getDevices();
      this.startPolling();
    } catch (e) {
      this.log.error('Errore avvio, riprovo in 30s:', e.message);
      setTimeout(() => this.start(), 30000);
    }
  }

  startPolling() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    this.pollStatus();
    this._pollTimer = setInterval(() => this.pollStatus(), this.pollInterval);
  }

  // --- HTTP ---

  apiGet(payload) {
    return new Promise((resolve, reject) => {
      const path = '/?req=' + encodeURIComponent(JSON.stringify(payload));
      const req = https.request(
        { hostname: INIM_HOST, path, method: 'GET', headers: INIM_HEADERS },
        (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            try { resolve(JSON.parse(data)); }
            catch (e) { reject(new Error('Parse error: ' + data.substring(0, 200))); }
          });
        }
      );
      req.on('error', reject);
      req.end();
    });
  }

  // --- Autenticazione ---

  async authenticate() {
    this.log('Autenticazione INIM Cloud...');
    const res = await this.apiGet({
      Node: '', Name: '', ClientIP: '',
      Method: 'RegisterClient',
      ClientId: '', Token: '',
      Params: {
        Username:   this.config.email,
        Password:   this.config.password,
        ClientId:   this.clientId,
        ClientName: 'Homebridge',
        ClientInfo: JSON.stringify({
          name: 'homebridge', version: '1.0.0',
          device: 'Homebridge', brand: 'Homebridge', platform: 'linux',
        }),
        Role: '1', Brand: '0',
      },
    });
    if (res.Status !== 0) throw new Error('Auth fallita: ' + res.ErrMsg);
    this.token = res.Data?.Token;
    if (!this.token) throw new Error('Nessun token ricevuto');
    this.log('Autenticazione OK');
  }

  // --- Recupero centrale ---

  async getDevices() {
    this.log('Recupero centrale...');
    const res = await this.apiGet({
      Node: 'inimhome', Name: 'it.inim.inimutenti', ClientIP: '',
      Method: 'GetDevicesExtended',
      Token: this.token, ClientId: this.clientId,
      Context: null,
      Params: { Info: '16908287' },
    });
    if (res.Status !== 0) throw new Error('GetDevicesExtended fallita: ' + res.ErrMsg);
    const devices = res.Data?.Devices || [];
    if (!devices.length) throw new Error('Nessuna centrale trovata');
    const device = devices[0];
    this.deviceId = device.DeviceId;
    this.log('Centrale:', device.Name, '| DeviceId:', this.deviceId);
    this.applyState(device.ActiveScenario ?? 0,
      (device.Areas || []).some(a => a.Alarm === 1));
  }

  // --- Polling ---

  async pollStatus() {
    if (!this.token || !this.deviceId) return;
    try {
      const res = await this.apiGet({
        Params: { DeviceId: this.deviceId, Type: 5 },
        Node: '', Name: 'Homebridge', ClientIP: '',
        Method: 'RequestPoll',
        Token: this.token, ClientId: this.clientId,
        Context: 'intrusion',
      });
      if (TOKEN_EXPIRED.has(res.Status)) {
        this.log('Token scaduto, riautentico...');
        this.token = null;
        clearInterval(this._pollTimer);
        await this.start();
        return;
      }
      if (res.Status !== 0 || !res.Data) return;
      const d = res.Data[String(this.deviceId)]
             || res.Data[this.deviceId]
             || Object.values(res.Data)[0];
      if (!d) return;
      this.applyState(
        d.ActiveScenario ?? d.Scenario ?? 0,
        !!(d.Alarm || d.InAlarm)
      );
    } catch (e) {
      this.log.error('Errore polling:', e.message);
    }
  }

  applyState(scenario, hasAlarm) {
    const { Characteristic } = this.api.hap;
    const newState = hasAlarm
      ? CURRENT.ALARM
      : (this.scenarioToState[scenario] ?? CURRENT.DISARMED);
    if (newState !== this.currentState) {
      this.currentState = newState;
      this.secService
        .getCharacteristic(Characteristic.SecuritySystemCurrentState)
        .updateValue(newState);
      this.log('Stato:', this.stateLabel(newState),
        hasAlarm ? '' : '(scenario ' + scenario + ')');
    }
  }

  // --- Comando ---

  async handleSet(value) {
    const scenarioId = this.targetToScenario[value];
    const mode       = this.targetToMode[value];
    if (scenarioId === undefined) return;
    this.log('Comando:', this.targetLabel(value), '| scenario:', scenarioId);
    try {
      const res = await this.apiGet({
        Node: 'inimhome', Name: 'it.inim.inimutenti', ClientIP: '',
        Method: 'InsertAreas',
        Token: this.token, ClientId: this.clientId,
        Params: {
          AreaIds: [0, 1, 2],
          Mode: mode,
          DeviceId: String(this.deviceId),
          Code: String(this.config.userCode),
        },
      });
      if (res.Status !== 0) throw new Error(res.ErrMsg || 'Errore InsertAreas');
      this.targetState = value;
      this.log('Comando OK');
    } catch (e) {
      this.log.error('Errore comando:', e.message);
      throw e;
    }
  }

  // --- Label ---
  stateLabel(s) {
    return ['CASA', 'NOTTE', 'TOTALE', 'DISINSERITO', 'ALLARME'][s] ?? s;
  }
  targetLabel(s) {
    return ['CASA', 'NOTTE', 'TOTALE', 'DISINSERITO'][s] ?? s;
  }
}
