import https from 'https';
import { randomUUID } from 'crypto';

const INIM_HOST = 'api.inimcloud.com';
const INIM_HEADERS = {
  'Host': 'api.inimcloud.com',
  'Accept': '*/*',
  'Accept-Language': 'it-it',
  'Accept-Encoding': 'identity',
  'User-Agent': 'Inim Home/5 CFNetwork/1329 Darwin/21.3.0',
};
const TOKEN_EXPIRED_CODES = new Set([2, 18, 19, 20, 27]);

export default (homebridge) => {
  const { Service, Characteristic } = homebridge.hap;

  // Valori numerici stati HomeKit (stabili, non cambiano)
  const STATE = {
    STAY_ARM:        0,
    NIGHT_ARM:       1,
    AWAY_ARM:        2,
    DISARMED:        3,
    ALARM_TRIGGERED: 4,
  };
  const TARGET = {
    STAY_ARM:  0,
    NIGHT_ARM: 1,
    AWAY_ARM:  2,
    DISARM:    3,
  };

  class InimCloud {
    constructor(log, config) {
      this.log      = log;
      this.email    = config.email;
      this.password = config.password;
      this.userCode = String(config.userCode || '');

      // Mappatura scenari INIM configurabile dalla UI
      this.scenarios = {
        disarmed: config.scenarioDisarmed ?? 0,
        home:     config.scenarioHome     ?? 1,
        night:    config.scenarioNight    ?? 2,
        away:     config.scenarioAway     ?? 3,
      };

      // ScenarioId INIM → stato corrente HomeKit
      this.scenarioToCurrentState = {
        [this.scenarios.disarmed]: STATE.DISARMED,
        [this.scenarios.home]:     STATE.STAY_ARM,
        [this.scenarios.night]:    STATE.NIGHT_ARM,
        [this.scenarios.away]:     STATE.AWAY_ARM,
      };

      // Stato target HomeKit → scenarioId INIM
      this.targetStateToScenario = {
        [TARGET.DISARM]:    this.scenarios.disarmed,
        [TARGET.STAY_ARM]:  this.scenarios.home,
        [TARGET.NIGHT_ARM]: this.scenarios.night,
        [TARGET.AWAY_ARM]:  this.scenarios.away,
      };

      // Stato target HomeKit → Mode per InsertAreas (0=arm, 3=disarm)
      this.targetStateToMode = {
        [TARGET.DISARM]:    3,
        [TARGET.STAY_ARM]:  0,
        [TARGET.NIGHT_ARM]: 0,
        [TARGET.AWAY_ARM]:  0,
      };

      this.pollInterval = (config.pollInterval ?? 15) * 1000;
      this.clientId     = 'hb-' + randomUUID();
      this.token        = null;
      this.deviceId     = null;
      this.currentState = STATE.DISARMED;
      this.targetState  = TARGET.DISARM;
      this._pollTimer   = null;

      // Security System service
      this.securityService = new Service.SecuritySystem(config.name || 'Allarme Casa');
      this.securityService
        .getCharacteristic(Characteristic.SecuritySystemCurrentState)
        .onGet(() => this.currentState);
      this.securityService
        .getCharacteristic(Characteristic.SecuritySystemTargetState)
        .onGet(() => this.targetState)
        .onSet((value) => this.handleSet(value));

      // Info service
      this.infoService = new Service.AccessoryInformation();
      this.infoService
        .setCharacteristic(Characteristic.Manufacturer, 'INIM Electronics')
        .setCharacteristic(Characteristic.Model, 'Prime Cloud')
        .setCharacteristic(Characteristic.FirmwareRevision, '5.0.0');

      this.start();
    }

    // --- Avvio e riavvio ---

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
          Username:   this.email,
          Password:   this.password,
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

    async handleTokenExpired() {
      this.log('Token scaduto, riautentico...');
      this.token = null;
      clearInterval(this._pollTimer);
      await this.start();
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

      // Stato iniziale dalla risposta
      this.applyScenarioState(device.ActiveScenario ?? 0,
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

        if (TOKEN_EXPIRED_CODES.has(res.Status)) {
          await this.handleTokenExpired();
          return;
        }
        if (res.Status !== 0 || !res.Data) return;

        const deviceData =
          res.Data[String(this.deviceId)] ||
          res.Data[this.deviceId] ||
          Object.values(res.Data)[0];
        if (!deviceData) return;

        this.applyScenarioState(
          deviceData.ActiveScenario ?? deviceData.Scenario ?? 0,
          !!(deviceData.Alarm || deviceData.InAlarm)
        );
      } catch (e) {
        this.log.error('Errore polling:', e.message);
      }
    }

    applyScenarioState(activeScenario, hasAlarm) {
      const newState = hasAlarm
        ? STATE.ALARM_TRIGGERED
        : (this.scenarioToCurrentState[activeScenario] ?? STATE.DISARMED);

      if (newState !== this.currentState) {
        this.currentState = newState;
        this.securityService
          .getCharacteristic(Characteristic.SecuritySystemCurrentState)
          .updateValue(newState);
        this.log('Stato:', this.stateLabel(newState),
          hasAlarm ? '' : '(scenario INIM ' + activeScenario + ')');
      }
    }

    // --- Comando ---

    async handleSet(value) {
      const scenarioId = this.targetStateToScenario[value];
      const mode       = this.targetStateToMode[value];
      if (scenarioId === undefined) {
        this.log.error('Stato HomeKit non mappato:', value);
        return;
      }
      this.log('Comando:', this.targetLabel(value),
        '| scenario INIM:', scenarioId, '| mode:', mode);
      try {
        const res = await this.apiGet({
          Node: 'inimhome', Name: 'it.inim.inimutenti', ClientIP: '',
          Method: 'InsertAreas',
          Token: this.token, ClientId: this.clientId,
          Params: {
            AreaIds: [0, 1, 2],
            Mode: mode,
            DeviceId: String(this.deviceId),
            Code: this.userCode,
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

    // --- Label log ---

    stateLabel(s) {
      return ['INSERITO CASA', 'INSERITO NOTTE', 'INSERITO TOTALE', 'DISINSERITO', 'ALLARME'][s] ?? s;
    }
    targetLabel(s) {
      return ['INSERITO CASA', 'INSERITO NOTTE', 'INSERITO TOTALE', 'DISINSERITO'][s] ?? s;
    }

    getServices() {
      return [this.infoService, this.securityService];
    }
  }

  homebridge.registerAccessory('homebridge-inim-cloud', 'InimCloud', InimCloud);
};
