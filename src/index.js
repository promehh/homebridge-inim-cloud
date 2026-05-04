const https = require(‘https’);

const url = require(‘url’);

let Service, Characteristic;

const INIM_API = ‘https://api.inimcloud.com/’;

module.exports = (homebridge) => {

Service = homebridge.hap.Service;

Characteristic = homebridge.hap.Characteristic;

homebridge.registerAccessory(‘homebridge-inim-cloud’, ‘InimCloud’, InimCloud);

};

class InimCloud {

constructor(log, config) {

this.log = log;

this.name = config.name || ‘Allarme Casa’;

this.email = config.email;

this.password = config.password;

this.deviceIndex = config.deviceIndex || 0;

this.armScenario = config.armScenario || 1;

this.disarmScenario = config.disarmScenario || 0;

this.pollInterval = (config.pollInterval || 10) * 1000;

```

this.token = 0;

this.clientId = 0;

this.deviceId = null;

this.currentState = Characteristic.SecuritySystemCurrentState.DISARMED;

this.targetState = Characteristic.SecuritySystemTargetState.DISARM;

// Security System service

this.securityService = new Service.SecuritySystem(this.name);

this.securityService

  .getCharacteristic(Characteristic.SecuritySystemCurrentState)

  .on('get', (cb) => cb(null, this.currentState));

this.securityService

  .getCharacteristic(Characteristic.SecuritySystemTargetState)

  .on('get', (cb) => cb(null, this.targetState))

  .on('set', this.setTargetState.bind(this));

// Info service

this.infoService = new Service.AccessoryInformation();

this.infoService

  .setCharacteristic(Characteristic.Manufacturer, 'INIM Electronics')

  .setCharacteristic(Characteristic.Model, 'Cloud Plugin')

  .setCharacteristic(Characteristic.SerialNumber, '1.0.0');

// Start authentication flow

this.authenticate(() => {

  this.getDeviceList(() => {

    this.pollStatus();

    setInterval(() => this.pollStatus(), this.pollInterval);

  });

});

```

}

// — INIM Cloud API methods —

apiRequest(method, params, callback) {

const payload = {

Node: ‘’,

Name: ‘AlienMobilePro’,

ClientIP: ‘’,

Method: method,

ClientId: this.clientId !== null ? this.clientId : 0,

Token: this.token !== null ? this.token : 0,

Params: params

};

```

const encoded = encodeURIComponent(JSON.stringify(payload));

const reqUrl = url.parse(INIM_API + '?req=' + encoded);

const options = {

  hostname: reqUrl.hostname,

  path: reqUrl.path,

  method: 'GET',

  headers: { 'User-Agent': 'AlienMobilePro' }

};

const req = https.request(options, (res) => {

  let data = '';

  res.on('data', (chunk) => data += chunk);

  res.on('end', () => {

    try {

      const parsed = JSON.parse(data);

      callback(null, parsed);

    } catch (e) {

      callback(new Error('JSON parse error: ' + e.message));

    }

  });

});

req.on('error', callback);

req.end();

```

}

authenticate(callback) {

this.log(‘Autenticazione INIM Cloud…’);

this.apiRequest(‘Authenticate’, {

User: this.email,

Password: this.password

}, (err, res) => {

if (err) {

this.log(‘Errore autenticazione:’, err.message);

setTimeout(() => this.authenticate(callback), 30000);

return;

}

```

  if (res.Status !== 0) {

    this.log('Autenticazione fallita:', res.ErrMsg || JSON.stringify(res));

    setTimeout(() => this.authenticate(callback), 30000);

    return;

  }

  this.token = res.Data.Token;

  this.clientId = res.Data.ClientId;

  this.log('Autenticazione OK — Token ricevuto');

  if (callback) callback();

});

```

}

getDeviceList(callback) {

this.log(‘Recupero lista centrali…’);

this.apiRequest(‘GetDeviceList’, {}, (err, res) => {

if (err || res.Status !== 0) {

this.log(‘Errore recupero centrali:’, err ? err.message : res.ErrMsg);

return;

}

```

  const devices = res.Data;

  if (!devices || devices.length === 0) {

    this.log('Nessuna centrale trovata nel cloud INIM');

    return;

  }

  const device = devices[this.deviceIndex];

  if (!device) {

    this.log('Indice centrale non valido. Centrali disponibili:', devices.length);

    return;

  }

  this.deviceId = device.DeviceId;

  this.log('Centrale trovata:', device.Name || device.DeviceId);

  if (callback) callback();

});

```

}

pollStatus() {

if (!this.token || !this.deviceId) {

this.authenticate(() => this.getDeviceList(() => this.pollStatus()));

return;

}

```

this.apiRequest('RequestPoll', {

  DeviceId: this.deviceId,

  Type: 5

}, (err, res) => {

  if (err) {

    this.log('Errore polling:', err.message);

    return;

  }

  if (res.Status === 2) {

    // Token scaduto — riautentica

    this.token = null;

    this.authenticate(() => this.pollStatus());

    return;

  }

  if (res.Status !== 0 || !res.Data) return;

  try {

    const scenario = res.Data.Scenario || 0;

    const hasAlarm = res.Data.Alarm || false;

    let newState;

    if (hasAlarm) {

      newState = Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED;

    } else if (scenario > 0) {

      newState = Characteristic.SecuritySystemCurrentState.AWAY_ARM;

    } else {

      newState = Characteristic.SecuritySystemCurrentState.DISARMED;

    }

    if (newState !== this.currentState) {

      this.currentState = newState;

      this.securityService

        .getCharacteristic(Characteristic.SecuritySystemCurrentState)

        .updateValue(newState);

      const labels = ['INSERITO CASA', 'INSERITO NOTTE', 'INSERITO TOTALE', 'DISINSERITO', 'ALLARME'];

      this.log('Stato aggiornato:', labels[newState] || newState);

    }

  } catch (e) {

    this.log('Errore parsing stato:', e.message);

  }

});

```

}

setTargetState(value, callback) {

const scenario = (value === Characteristic.SecuritySystemTargetState.DISARM)

? this.disarmScenario

: this.armScenario;

```

this.log('Invio comando scenario:', scenario);

this.apiRequest('SetScenario', {

  DeviceId: this.deviceId,

  Scenario: scenario

}, (err, res) => {

  if (err) {

    this.log('Errore comando:', err.message);

    callback(err);

    return;

  }

  if (res.Status !== 0) {

    this.log('Comando rifiutato:', res.ErrMsg || JSON.stringify(res));

    callback(new Error(res.ErrMsg));

    return;

  }

  this.targetState = value;

  this.log('Comando inviato con successo');

  callback(null);

});

```

}

getServices() {

return [this.infoService, this.securityService];

}

}
 
