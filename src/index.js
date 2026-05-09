import https from 'https';

const INIM_HOST = 'api.inimcloud.com';

export default (homebridge) => {
  const { Service, Characteristic } = homebridge.hap;

  homebridge.registerAccessory('homebridge-inim-cloud', 'InimCloud', class InimCloud {
    constructor(log, config) {
      this.log = log;
      this.name = config.name || 'Allarme Casa';
      this.email = config.email;
      this.password = config.password;
      this.deviceIndex = config.deviceIndex ?? 0;
      this.armScenario = config.armScenario ?? 1;
      this.disarmScenario = config.disarmScenario ?? 0;
      this.pollInterval = (config.pollInterval ?? 15) * 1000;

      this.clientId = null;
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
        .setCharacteristic(Characteristic.SerialNumber, '2.0.0');

      this.authenticate().then(() => this.getDeviceList()).then(() => {
        this.pollStatus();
        setInterval(() => this.pollStatus(), this.pollInterval);
      }).catch((e) => this.log.error('Errore avvio:', e.message));
    }

    apiGet(path) {
      return new Promise((resolve, reject) => {
        const options = {
          hostname: INIM_HOST,
          path,
          method: 'GET',
          headers: { 'User-Agent': 'AlienMobilePro/1.0', Accept: 'application/json' }
        };
        const req = https.request(options, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try { resolve(JSON.parse(data)); }
            catch (e) { reject(new Error('Parse error: ' + e.message + ' | raw: ' + data.substring(0, 300))); }
          });
        });
        req.on('error', reject);
        req.end();
      });
    }

    buildAuthPath() {
      // Formato documentato dalla community INIM:
      // ClientId e Token sono numeri (0) nella prima chiamata
      // User e Password vanno dentro Params
      const payload = {
        Node: '',
        Name: 'AlienMobilePro',
        ClientIP: '',
        Method: 'Authenticate',
        ClientId: 0,
        Token: 0,
        Params: {
          User: this.email,
          Password: this.password
        }
      };
      return '/?req=' + encodeURIComponent(JSON.stringify(payload));
    }

    buildPath(method, params) {
      const payload = {
        Node: '',
        Name: 'AlienMobilePro',
        ClientIP: '',
        Method: method,
        ClientId: this.clientId,
        Token: this.token,
        Params: params
      };
      return '/?req=' + encodeURIComponent(JSON.stringify(payload));
    }

    async authenticate() {
      this.log('Autenticazione INIM Cloud...');
      try {
        const res = await this.apiGet(this.buildAuthPath());
        this.log('Risposta auth:', JSON.stringify(res));
        if (res.Status !== 0) {
          throw new Error(res.ErrMsg || 'Auth fallita status: ' + res.Status);
        }
        this.token = res.Data.Token;
        this.clientId = res.Data.ClientId;
        this.log('Autenticazione OK — ClientId:', this.clientId, '| Token:', this.token);
      } catch (e) {
        this.log.error('Errore autenticazione:', e.message);
        await new Promise(r => setTimeout(r, 30000));
        return this.authenticate();
      }
    }

    async getDeviceList() {
      this.log('Recupero lista centrali...');
      try {
        const res = await this.apiGet(this.buildPath('GetDeviceList', {}));
        this.log('Risposta device list:', JSON.stringify(res));
        if (res.Status !== 0) throw new Error(res.ErrMsg);
        const devices = res.Data;
        if (!devices?.length) throw new Error('Nessuna centrale trovata');
        const device = devices[this.deviceIndex];
        if (!device) throw new Error('Indice centrale non valido, disponibili: ' + devices.length);
        this.deviceId = device.DeviceId;
        this.log('Centrale trovata:', device.Name, '| DeviceId:', this.deviceId);
      } catch (e) {
        this.log.error('Errore GetDeviceList:', e.message);
      }
    }

    async pollStatus() {
      if (!this.token || !this.deviceId) return;
      try {
        const res = await this.apiGet(this.buildPath('RequestPoll', {
          DeviceId: this.deviceId,
          Type: 5
        }));
        if (res.Status === 2) {
          this.log('Token scaduto, riautentico...');
          this.token = null;
          this.clientId = null;
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
        const res = await this.apiGet(this.buildPath('ActivateScenario', {
          DeviceId: this.deviceId,
          ScenarioId: scenarioId
        }));
        if (res.Status !== 0) throw new Error(res.ErrMsg || 'Errore scenario');
        this.targetState = value;
        this.log('Scenario attivato OK');
      } catch (e) {
        this.log.error('Errore ActivateScenario:', e.message);
        throw e;
      }
    }

    getServices() {
      return [this.infoService, this.securityService];
    }
  });
};
