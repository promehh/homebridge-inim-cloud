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
      this.userCode = config.userCode || '';
      this.deviceIndex = config.deviceIndex ?? 0;
      this.armScenario = config.armScenario ?? 1;
      this.disarmScenario = config.disarmScenario ?? 0;
      this.pollInterval = (config.pollInterval ?? 15) * 1000;

      this.clientId = null;
      this.token = null;
      this.deviceId = null;
      this.currentState = 3;
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
        .setCharacteristic(Characteristic.SerialNumber, '3.0.0');

      this.start();
    }

    async start() {
      try {
        await this.authenticate();
        await this.getDeviceList();
        if (this.userCode) await this.authenticateCode();
        this.pollStatus();
        setInterval(() => this.pollStatus(), this.pollInterval);
      } catch (e) {
        this.log.error('Errore avvio:', e.message);
        setTimeout(() => this.start(), 30000);
      }
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
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            try { resolve(JSON.parse(data)); }
            catch (e) { reject(new Error('Parse error: ' + data.substring(0, 200))); }
          });
        });
        req.on('error', reject);
        req.end();
      });
    }

    authPath(method, params) {
      return '/?req=' + encodeURIComponent(JSON.stringify({
        Node: '', Name: 'AlienMobilePro', ClientIP: '', Method: method, Params: params
      }));
    }

    buildPath(method, params) {
      return '/?req=' + encodeURIComponent(JSON.stringify({
        Node: '', Name: 'AlienMobilePro', ClientIP: '',
        Method: method, ClientId: this.clientId, Token: this.token, Params: params
      }));
    }

    async authenticate() {
      this.log('Step 1: Autenticazione email/password...');
      const res = await this.apiGet(this.authPath('Authenticate', {
        User: this.email,
        Password: this.password
      }));
      this.log('Risposta auth:', JSON.stringify(res));
      if (res.Status !== 0) throw new Error('Auth fallita: ' + res.ErrMsg + ' (Status ' + res.Status + ')');
      this.clientId = res.Data.ClientId;
      this.token = res.Data.Token;
      this.log('Step 1 OK — ClientId:', this.clientId, '| Token:', this.token);
    }

    async getDeviceList() {
      this.log('Step 2: Recupero lista centrali...');
      const res = await this.apiGet(this.buildPath('GetDeviceList', {}));
      this.log('Device list:', JSON.stringify(res));
      if (res.Status !== 0) throw new Error('GetDeviceList fallita: ' + res.ErrMsg);
      const devices = res.Data;
      if (!devices?.length) throw new Error('Nessuna centrale trovata');
      const device = devices[this.deviceIndex];
      if (!device) throw new Error('Indice non valido. Disponibili: ' + devices.length);
      this.deviceId = device.DeviceId;
      this.log('Step 2 OK — Centrale:', device.Name, '| DeviceId:', this.deviceId);
    }

    async authenticateCode() {
      this.log('Step 3: Autenticazione PIN...');
      const res = await this.apiGet(this.buildPath('AuthenticateCode', {
        DeviceId: this.deviceId,
        Code: parseInt(this.userCode),
        Role: '1'
      }));
      this.log('Risposta PIN:', JSON.stringify(res));
      if (res.Status !== 0) {
        this.log.warn('PIN non accettato (continuo senza):', res.ErrMsg);
      } else {
        if (res.Data?.Token) this.token = res.Data.Token;
        if (res.Data?.ClientId) this.clientId = res.Data.ClientId;
        this.log('Step 3 OK — token aggiornato');
      }
    }

    async pollStatus() {
      if (!this.token || !this.deviceId) return;
      try {
        const res = await this.apiGet(this.buildPath('RequestPoll', {
          DeviceId: this.deviceId, Type: 5
        }));
        if (res.Status === 2) {
          this.log('Token scaduto, riavvio autenticazione...');
          this.token = null; this.clientId = null;
          await this.start();
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
          DeviceId: this.deviceId, ScenarioId: scenarioId
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
