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

export default (homebridge) => {
  const { Service, Characteristic } = homebridge.hap;

  homebridge.registerAccessory('homebridge-inim-cloud', 'InimCloud', class InimCloud {
    constructor(log, config) {
      this.log = log;
      this.name = config.name || 'Allarme Casa';
      this.email = config.email;
      this.password = config.password;
      this.userCode = String(config.userCode || '');
      this.deviceIndex = config.deviceIndex ?? 0;
      this.armScenario = config.armScenario ?? 0;
      this.disarmScenario = config.disarmScenario ?? 1;
      this.pollInterval = (config.pollInterval ?? 15) * 1000;

      // ClientId è una stringa UUID generata una volta e riusata
      this.clientId = 'hb-' + randomUUID();
      this.token = null;
      this.deviceId = null;
      this.currentState = 3; // DISARMED
      this.targetState = 3;

      this.securityService = new Service.SecuritySystem(this.name);
      this.securityService
        .getCharacteristic(Characteristic.SecuritySystemCurrentState)
        .onGet(() => this.currentState);
      this.securityService
        .getCharacteristic(Characteristic.SecuritySystemTargetState)
        .onGet(() => this.targetState)
        .onSet((value) => this.setTargetState(value));

      this.infoService = new Service.AccessoryInformation();
      this.infoService
        .setCharacteristic(Characteristic.Manufacturer, 'INIM Electronics')
        .setCharacteristic(Characteristic.Model, 'Prime Cloud Plugin')
        .setCharacteristic(Characteristic.SerialNumber, '4.0.0');

      this.start();
    }

    apiGet(payload) {
      return new Promise((resolve, reject) => {
        const reqJson = JSON.stringify(payload, null, 0).replace(/,/g, ',').replace(/:/g, ':');
        const path = '/?req=' + encodeURIComponent(reqJson);
        const options = {
          hostname: INIM_HOST,
          path,
          method: 'GET',
          headers: INIM_HEADERS
        };
        const req = https.request(options, (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            try { resolve(JSON.parse(data)); }
            catch (e) { reject(new Error('Parse error: ' + data.substring(0, 300))); }
          });
        });
        req.on('error', reject);
        req.end();
      });
    }

    async start() {
      try {
        await this.authenticate();
        await this.getDevices();
        this.pollStatus();
        setInterval(() => this.pollStatus(), this.pollInterval);
      } catch (e) {
        this.log.error('Errore avvio:', e.message);
        setTimeout(() => this.start(), 30000);
      }
    }

    async authenticate() {
      this.log('Autenticazione INIM Cloud (RegisterClient)...');
      const clientInfo = JSON.stringify({
        name: 'homebridge',
        version: '1.0.0',
        device: 'Homebridge',
        brand: 'Homebridge',
        platform: 'linux',
      });

      const payload = {
        Node: '',
        Name: '',
        ClientIP: '',
        Method: 'RegisterClient',
        ClientId: '',
        Token: '',
        Params: {
          Username: this.email,
          Password: this.password,
          ClientId: this.clientId,
          ClientName: 'Homebridge',
          ClientInfo: clientInfo,
          Role: '1',
          Brand: '0',
        },
      };

      const res = await this.apiGet(payload);
      this.log('Risposta auth:', JSON.stringify(res));
      if (res.Status !== 0) throw new Error('Auth fallita: ' + res.ErrMsg + ' (Status ' + res.Status + ')');
      this.token = res.Data?.Token;
      if (!this.token) throw new Error('Nessun token ricevuto');
      this.log('Auth OK — Token ricevuto');
    }

    async getDevices() {
      this.log('Recupero lista centrali (GetDevicesExtended)...');
      const payload = {
        Node: 'inimhome',
        Name: 'it.inim.inimutenti',
        ClientIP: '',
        Method: 'GetDevicesExtended',
        Token: this.token,
        ClientId: this.clientId,
        Context: null,
        Params: { Info: '16908287' },
      };
      const res = await this.apiGet(payload);
      this.log('Risposta devices:', JSON.stringify(res));
      if (res.Status !== 0) throw new Error('GetDevicesExtended fallita: ' + res.ErrMsg);
      const devices = res.Data?.Devices || [];
      if (!devices.length) throw new Error('Nessuna centrale trovata');
      const device = devices[this.deviceIndex];
      if (!device) throw new Error('Indice non valido. Disponibili: ' + devices.length);
      this.deviceId = device.DeviceId || device.Id || device.id;
      this.log('Centrale trovata:', device.Name, '| DeviceId:', this.deviceId);
    }

    async pollStatus() {
      if (!this.token || !this.deviceId) return;
      try {
        const payload = {
          Params: { DeviceId: this.deviceId, Type: 5 },
          Node: '',
          Name: 'Home Assistant',
          ClientIP: '',
          Method: 'RequestPoll',
          Token: this.token,
          ClientId: this.clientId,
          Context: 'intrusion',
        };
        const res = await this.apiGet(payload);
        if (res.Status === 2 || res.Status === 18 || res.Status === 19 || res.Status === 20) {
          this.log('Token scaduto, riautentico...');
          this.token = null;
          await this.authenticate();
          return;
        }
        if (res.Status !== 0 || !res.Data) return;

        const deviceData =
          res.Data[String(this.deviceId)] ||
          res.Data[this.deviceId] ||
          Object.values(res.Data)[0];

        if (!deviceData) {
          this.log('Dati centrale non trovati. Keys:', Object.keys(res.Data));
          return;
        }

        const scenario = deviceData.ActiveScenario ?? deviceData.Scenario ?? 0;
        const hasAlarm = deviceData.Alarm ?? deviceData.InAlarm ?? false;
        const newState = hasAlarm ? 4 : (scenario > 0 ? 1 : 3);

        if (newState !== this.currentState) {
          this.currentState = newState;
          this.securityService
            .getCharacteristic(Characteristic.SecuritySystemCurrentState)
            .updateValue(newState);
          this.log('Stato:', hasAlarm ? 'ALLARME' : (scenario > 0 ? 'INSERITO (sc.' + scenario + ')' : 'DISINSERITO'));
        }
      } catch (e) {
        this.log.error('Errore polling:', e.message);
      }
    }

    async setTargetState(value) {
      const scenarioId = value === 3 ? this.disarmScenario : this.armScenario;
      this.log('Attivazione scenario:', scenarioId);
      try {
        const payload = {
          Node: 'inimhome',
          Name: 'it.inim.inimutenti',
          ClientIP: '',
          Method: 'InsertAreas',
          Token: this.token,
          ClientId: this.clientId,
          Params: {
            AreaIds: [1],
            Mode: value === 3 ? 3 : 0,
            DeviceId: String(this.deviceId),
            Code: this.userCode,
          },
        };
        const res = await this.apiGet(payload);
        if (res.Status !== 0) throw new Error(res.ErrMsg || 'Errore InsertAreas');
        this.targetState = value;
        this.log('Comando OK');
      } catch (e) {
        this.log.error('Errore setTargetState:', e.message);
        throw e;
      }
    }

    getServices() {
      return [this.infoService, this.securityService];
    }
  });
};
