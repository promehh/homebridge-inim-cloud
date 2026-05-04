const https = require('https');
const url = require('url');

let Service, Characteristic;
const INIM_API = 'https://api.inimcloud.com/';

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
    this.pollInterval = (config.pollInterval || 10) * 1000;
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
      .setCharacteristic(Characteristic.Model, 'Cloud Plugin')
      .setCharacteristic(Characteristic.SerialNumber, '1.0.0');

    this.authenticate(() => {
      this.getDeviceList(() => {
        this.pollStatus();
        setInterval(() => this.pollStatus(), this.pollInterval);
      });
    });
  }

  apiRequest(method, params, callback) {
    const payload = {
      Node: '',
      Name: 'Inim Home',
      ClientIP: '',
      Method: method,
      Params: params
    };
    if (this.clientId !== null) payload.ClientId = this.clientId;
    if (this.token !== null) payload.Token = this.token;

    const encoded = encodeURIComponent(JSON.stringify(payload));
    const reqUrl = url.parse(INIM_API + '?req=' + encoded);
    const options = {
      hostname: reqUrl.hostname,
      path: reqUrl.path,
      method: 'GET',
      headers: { 'User-Agent': 'Inim Home' }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          callback(null, JSON.parse(data));
        } catch (e) {
          callback(new Error('JSON parse error: ' + e.message));
        }
      });
    });
    req.on('error', callback);
    req.end();
  }

  authenticate(callback) {
    this.log('Autenticazione INIM Cloud...');
    this.apiRequest('Authenticate', {
      User: this.email,
      Password: this.password
    }, (err, res) => {
      if (err) {
        this.log('Errore autenticazione:', err.message);
        setTimeout(() => this.authenticate(callback), 30000);
        return;
      }
      if (res.Status !== 0) {
        this.log('Autenticazione fallita:', JSON.stringify(res));
        setTimeout(() => this.authenticate(callback), 30000);
        return;
      }
      this.token = res.Data.Token;
      this.clientId = res.Data.ClientId;
      this.log('Autenticazione OK — ClientId:', this.clientId);
      if (callback) callback();
    });
  }

  getDeviceList(callback) {
    this.log('Recupero lista centrali...');
    this.apiRequest('GetDeviceList', {}, (err, res) => {
      if (err || res.Status !== 0) {
        this.log('Errore centrali:', err ? err.message : JSON.stringify(res));
        return;
      }
      const devices = res.Data;
      if (!devices || devices.length === 0) {
        this.log('Nessuna centrale trovata');
        return;
      }
      const device = devices[this.deviceIndex];
      if (!device) {
        this.log('Indice centrale non valido. Disponibili:', devices.length);
        return;
      }
      this.deviceId = device.DeviceId;
      this.log('Centrale trovata:', device.Name || device.DeviceId);
      if (callback) callback();
    });
  }

  pollStatus() {
    if (!this.token || !this.deviceId) {
      this.authenticate(() => this.getDeviceList(() => this.pollStatus()));
      return;
    }
    this.apiRequest('RequestPoll', {
      DeviceId: this.deviceId,
      Type: 5
    }, (err, res) => {
      if (err) { this.log('Errore polling:', err.message); return; }
      if (res.Status === 2) {
        this.token = null;
        this.clientId = null;
        this.authenticate(() => this.pollStatus());
        return;
      }
      if (res.Status !== 0 || !res.Data) return;
      try {
        const scenario = res.Data.Scenario || 0;
        const hasAlarm = res.Data.Alarm || false;
        const newState = hasAlarm ? 4 : (scenario > 0 ? 1 : 3);
        if (newState !== this.currentState) {
          this.currentState = newState;
          this.securityService
            .getCharacteristic(Characteristic.SecuritySystemCurrentState)
            .updateValue(newState);
          this.log('Stato:', hasAlarm ? 'ALLARME' : (scenario > 0 ? 'INSERITO' : 'DISINSERITO'));
        }
      } catch (e) { this.log('Errore stato:', e.message); }
    });
  }

  setTargetState(value, callback) {
    const scenario = value === 3 ? this.disarmScenario : this.armScenario;
    this.log('Invio scenario:', scenario);
    this.apiRequest('SetScenario', {
      DeviceId: this.deviceId,
      Scenario: scenario
    }, (err, res) => {
      if (err) { callback(err); return; }
      if (res.Status !== 0) { callback(new Error(res.ErrMsg)); return; }
      this.targetState = value;
      this.log('Comando OK');
      callback(null);
    });
  }

  getServices() {
    return [this.infoService, this.securityService];
  }
}
