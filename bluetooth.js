var connectButton = document.getElementById("connectButton");
var bluetoothInfo = document.getElementById("bluetoothInfo");
var stats = document.getElementById("stats");
var logElement = document.getElementById("log");

const UINT16_MAX = 65536; // 2^16
const UINT32_MAX = 4294967296; // 2^32
const updateRatio = 0.85; // Percent ratio between old/new stats

// Bluetooth constants
const serviceUuid = "cycling_speed_and_cadence";
const characteristicUuid = "csc_measurement";

var simulate = false,
    duration = 0;
var previousSample, currentSample, bluetoothStats, hasWheel, hasCrank, startDistance, wheelSize;
var characteristic, bluetoothDevice, lastUpdate, wakeLock, wakeLockRequest;

window.onload = () => {
    feather.replace();

    stats.innerText = "0.0 rpm";

    if (window.location.protocol != 'https:' && window.location.hostname !== 'localhost') {
        connectButton.classList.add('disabled');
    }

    if (navigator.battery) {
        setupBattery(navigator.battery);
    } else if (navigator.getBattery) {
        navigator.getBattery().then(setupBattery);
    }

    if (navigator.getWakeLock) {
        navigator.getWakeLock('system').then(l => wakeLock = l);
    }

    // Update clock every 5 seconds
    setIntervalImmediately(() => {
        // Got code from https://stackoverflow.com/questions/8888491/
        let date = new Date();
        let hours = date.getHours();
        let minutes = date.getMinutes();
        let ampm = hours >= 12 ? 'pm' : 'am';
        hours = hours % 12;
        hours = hours ? hours : 12; // the hour '0' should be '12'
        minutes = minutes < 10 ? '0' + minutes : minutes;
        time.innerHTML = hours + ':' + minutes + ' ' + ampm;
    }, 5000);
}

function setIntervalImmediately(callback, time) {
    callback();
    setInterval(callback, time);
}

function setupBattery(b) {
    battery.innerHTML = (b.level * 100).toFixed(0) + '%';
    b.addEventListener("levelchange", () => {
        battery.innerHTML = (b.level * 100).toFixed(0) + '%';
    });
}

function handleButton() {
    if (bluetoothDevice) {
        console.log('Disconnecting from bluetooth device');
        cleanup();
        return;
    }

    if (wakeLock && !wakeLock.active) {
        wakeLockRequest = wakeLock.createRequest();
    }

    console.log('Requesting Bluetooth Device...');
    navigator.bluetooth.requestDevice({
            filters: [{
                services: [serviceUuid]
            }]
        })
        //navigator.bluetooth.requestDevice({acceptAllDevices: true})
        // the rest of the logic is inside connect()
        .then(device => {
            console.log('Connected to device', device);
            bluetoothDevice = device;
            bluetoothDevice.addEventListener('gattserverdisconnected', onDisconnected);
            connect();
        })
        .catch(error => {
            console.error('Failed to connect!', error);
            cleanup();
        });
}

function cleanup() {
    console.log('Cleaning up');
    connectButton.innerHTML = '<i data-feather="zap-off"></i>';
    feather.replace();
    if (bluetoothDevice) {
        bluetoothDevice.removeEventListener('gattserverdisconnected', onDisconnected);
        bluetoothDevice = undefined;
    }

    if (wakeLockRequest) {
        wakeLockRequest.cancel();
        wakeLockRequest = undefined;
    }

    lastUpdate = undefined;

    if (characteristic) {
        characteristic.stopNotifications()
            .then(() => {
                console.log('Notifications stopped');
                characteristic.removeEventListener('characteristicvaluechanged', handleNotifications);
                characteristic = undefined;
                bluetoothStats = undefined;
            })
            .catch(error => {
                console.error('Failed to stop notifications.', error);
            });
    }
}

// Auto reconnect code from: https://googlechrome.github.io/samples/web-bluetooth/automatic-reconnect.html
function connect() {
    exponentialBackoff(3 /* max retries */ , 2 /* seconds delay */ ,
        function toTry() {
            if (bluetoothDevice) {
                console.log('Connecting to Bluetooth Device... ');
                return bluetoothDevice.gatt.connect()
                    .then(server => {
                        console.log('Getting Service...', server);
                        return server.getPrimaryService(serviceUuid);
                    })
                    .then(service => {
                        console.log('Getting Characteristic...', service);
                        return service.getCharacteristic(characteristicUuid);
                    })
                    .then(c => {
                        characteristic = c;
                        return characteristic.startNotifications().then(_ => {
                            console.log('Notifications started', characteristic);
                            characteristic.addEventListener('characteristicvaluechanged', handleNotifications);
                            connectButton.innerHTML = '<i data-feather="zap"></i>';
                            feather.replace();
                        });
                    }).catch(error => {
                        console.error('Failed to connect!', error);
                        cleanup();
                    });
            }
        },
        function success() {
            console.log('Bluetooth Device connected');
        },
        function fail() {
            console.log('Failed to reconnect');
            cleanup();
        });
}

function onDisconnected() {
    console.log('Bluetooth Device disconnected');
    lastUpdate = undefined;
    connect();
}

// This function keeps calling "toTry" until promise resolves or has
// retried "max" number of times. First retry has a delay of "delay" seconds.
// "success" is called upon success.
function exponentialBackoff(max, delay, toTry, success, fail) {
    return toTry().then(result => success(result))
        .catch(_ => {
            if (max === 0) {
                return fail();
            }
            console.log('Retrying in ' + delay + 's... (' + max + ' tries left)');
            setTimeout(function () {
                exponentialBackoff(--max, delay * 2, toTry, success, fail);
            }, delay * 1000);
        });
}

function handleNotifications(event) {
    previousSample = currentSample;


    const value = event.target.value;

    const flags = value.getUint8(0, true);
    hasCrank = flags === 2 || flags === 3;

    currentSample = {
        crank: value.getUint16(1, true),
        crankTime: value.getUint16(3, true),
    };


    calculateStats();

    if (bluetoothStats) {
        if (bluetoothStats.cadence) {
            data = bluetoothStats.cadence.toFixed(1) + " rpm\n";

            stats.innerText = data;
        }
    }
}


function diffForSample(current, previous, max) {
    if (current > previous) {
        return current - previous;
    } else if (current === previous) {
        return -1;
    } else {
        return (current + max) - previous;
    }
}

function calculateStats() {
    var cadence;
    if (hasCrank) {
        let crankTimeDiff = diffForSample(currentSample.crankTime, previousSample.crankTime, UINT16_MAX);
        let crankDiff = diffForSample(currentSample.crank, previousSample.crank, UINT16_MAX);
        let prevCadence = cadence;
        cadence = crankTimeDiff > 0 && crankDiff > 0 ? ((crankDiff * 1024) / crankTimeDiff) * 60 : prevCadence; // RPM
        console.log(currentSample.crankTime, previousSample.crankTime, cadence);
    }

    if (bluetoothStats && cadence) {
        bluetoothStats = {
            cadence: cadence,
        };
    } else {
        bluetoothStats = {
            cadence: cadence,
        };
    }
}