const https = require('https');

let Service, Characteristic;
const INIM_HOST = 'api.inimcloud.com';

module.exports = (homebridge) => {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  homebridge.registerAccessory('homebridge-inim-cloud', 'InimCloud', InimCloud);
};

class InimCloud {
  constructor(log, config) {
    this.log = log;
    this.name = config.name || 'Allarme Casa';
    this.email = config.email;
    this.password = config.password;
    this.deviceIndex = config.deviceIndex || 0;
    this.armScenario = config.armScenario || 1;
    this.disarmScenario = config.disarmScenario || 0;
    this.pollInterval = (config.pollInterval || 15) * 1000;

    this.clientId = null;
    this.token = null;
    this.deviceId = null;
    this.currentState = 3;
    this.targetState = 3;

    this.securityService = new Service.SecuritySystem(this.name);
    this.securityService
      .getCharacteristic(Characteristic.SecuritySystemCurrentState)
      .on('get', (cb) => cb(null, this.currentState));
    this.securityService
      .getCharacteristic(Characteristic.SecuritySystemTargetState)
      .on('get', (cb) => cb(null, this.targetState))
      .on('set', this.setTargetState.bind(this));

    this.infoService = new Service.AccessoryInformation();
    this.infoService
      .setCharacteristic(Characteristic.Manufacturer, 'INIM Electronics')
      .setCharacteristic(Characteristic.Model, 'Prime Cloud Plugin')
      .setCharacteristic(Characteristic.SerialNumber, '1.0.0');

    this.authenticate(() => {
      this.getDeviceList(() => {
        this.pollStatus();
        setInterval(() => this.pollStatus(), this.pollInterval);
      });
    });
  }

  // Costruisce URL raw per Authenticate - ClientId e Token sono valori numerici nudi
  buildAuthUrl() {
    const raw = `{"Node":"","Name":"AlienMobilePro","ClientIP":"","Method":"Authenticate","ClientId":0,"Token":0,"Params":{"User":"${this.email}","Password":"${this.password}"}}`;
    return '/?' + 'req=' + encodeURIComponent(raw);
  }

  // Costruisce URL con JSON standard per chiamate post-auth
  buildUrl(method, params) {
    const payload = {
      Node: '',
      Name: 'AlienMobilePro',
      ClientIP: '',
      Method: method,
      ClientId: this.clientId,
      Token: this.token,
      Params: params
    };
    return '/?' + 'req=' + encodeURIComponent(JSON.stringify(payload));
  }

  apiGet(path, callback) {
    const options = {
      hostname: INIM_HOST,
      path: path,
      method: 'GET',
      headers: {
        'User-Agent': 'AlienMobilePro/1.0',
        'Accept': 'application/json'
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          callback(null, JSON.parse(data));
        } catch (e) {
          callback(new Error('Parse error: ' + e.message + ' | raw: ' + data.substring(0, 200)));
        }
      });
    });
    req.on('error', (e) => callback(new Error('Network error: ' + e.message)));
    req.end();
  }

  authenticate(callback) {
    this.log('Autenticazione INIM Cloud...');
    this.apiGet(this.buildAuthUrl(), (err, res) => {
      if (err) {
        this.log('Errore connessione:', err.message);
        setTimeout(() => this.authenticate(callback), 30000);
        return;
      }
      this.log('Risposta auth:', JSON.stringify(res));
      if (res.Status !== 0) {
        this.log('Auth fallita, riprovo in 30s. Errore:', res.ErrMsg);
        setTimeout(() => this.authenticate(callback), 30000);
        return;
      }
      this.token = res.Data.Token;
      this.clientId = res.Data.ClientId;
      this.log('Autenticazione OK — ClientId:', this.clientId, '| Token:', this.token);
      if (callback) callback();
    });
  }

  getDeviceList(callback) {
    this.log('Recupero lista centrali...');
    this.apiGet(this.buildUrl('GetDeviceList', {}), (err, res) => {
      if (err) {
        this.log('Errore GetDeviceList:', err.message);
        return;
      }
      this.log('Risposta device list:', JSON.stringify(res));
      if (res.Status !== 0) {
        this.log('GetDeviceList fallita:', res.ErrMsg);
        return;
      }
      const devices = res.Data;
      if (!devices || devices.length === 0) {
        this.log('Nessuna centrale trovata nel cloud');
        return;
      }
      const device = devices[this.deviceIndex];
      if (!device) {
        this.log('Indice centrale non valido. Disponibili:', devices.length);
        return;
      }
      this.deviceId = device.DeviceId;
      this.log('Centrale trovata:', device.Name, '| DeviceId:', this.deviceId);
      if (callback) callback();
    });
  }

  pollStatus() {
    if (!this.token || !this.deviceId) return;
    const path = this.buildUrl('RequestPoll', {
      DeviceId: this.deviceId,
      Type: 5
    });
    this.apiGet(path, (err, res) => {
      if (err) { this.log('Poll error:', err.message); return; }
      if (res.Status === 2) {
        this.log('Token scaduto, riautentico...');
        this.token = null;
        this.clientId = null;
        this.authenticate(() => {});
        return;
      }
      if (res.Status !== 0 || !res.Data) {
        this.log('Poll status non OK:', JSON.stringify(res));
        return;
      }
      try {
        const deviceData = res.Data[String(this.deviceId)] || res.Data[this.deviceId] || Object.values(res.Data)[0];
        if (!deviceData) {
          this.log('Dati centrale non trovati nel polling. Keys:', Object.keys(res.Data));
          return;
        }
        const scenario = deviceData.ActiveScenario || deviceData.Scenario || 0;
        const hasAlarm = deviceData.Alarm || deviceData.InAlarm || false;
        const newState = hasAlarm ? 4 : (scenario > 0 ? 1 : 3);
        if (newState !== this.currentState) {
          this.currentState = newState;
          this.securityService
            .getCharacteristic(Characteristic.SecuritySystemCurrentState)
            .updateValue(newState);
          this.log('Stato aggiornato:', hasAlarm ? 'ALLARME' : (scenario > 0 ? 'INSERITO (scenario ' + scenario + ')' : 'DISINSERITO'));
        }
      } catch (e) {
        this.log('Errore parsing stato:', e.message, '| Data:', JSON.stringify(res.Data).substring(0, 300));
      }
    });
  }

  setTargetState(value, callback) {
    const scenarioId = (value === Characteristic.SecuritySystemTargetState.DISARM)
      ? this.disarmScenario
      : this.armScenario;
    this.log('Attivazione scenario:', scenarioId);
    const path = this.buildUrl('ActivateScenario', {
      DeviceId: this.deviceId,
      ScenarioId: scenarioId
    });
    this.apiGet(path, (err, res) => {
      if (err) { callback(err); return; }
      if (res.Status !== 0) {
        this.log('ActivateScenario fallita:', res.ErrMsg);
        callback(new Error(res.ErrMsg || 'Errore scenario'));
        return;
      }
      this.targetState = value;
      this.log('Scenario attivato con successo');
      callback(null);
    });
  }

  getServices() {
    return [this.infoService, this.securityService];
  }
}
