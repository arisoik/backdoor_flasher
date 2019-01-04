const SerialPort = require('serialport');
const intelHex = require('intel-hex');
const fs = require('fs');

const electron = require('electron');
const app = electron.app;
const BrowserWindow = electron.BrowserWindow;
const ipc = electron.ipcMain;

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
var win;

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', createWindow);

// Quit when all windows are closed.
app.on('window-all-closed', () => {
    // On macOS it is common for applications and their menu bar
    // to stay active until the user quits explicitly with Cmd + Q
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (win === null) {
        createWindow();
    }
});

function createWindow() {
    // Create the browser window.
    var platform = process.platform, icon;
    if (platform === 'win32') {
        icon = './assets/icon.ico';
    } else if (platform === 'linux') {
        icon = './assets/256x256.png';
    } else if (platform === 'darwin') {
        icon = './assets/icon.icns';
    }
    win = new BrowserWindow({ width: 800, height: 600, frame: true, icon: icon }); // https://www.iconfinder.com/icons/102981/chip_icon
    win.setMenu(null);
    win.setResizable(false);

    ipc.on('open-URL', function (event, arg) {
        electron.shell.openExternal(arg);
    });

    ipc.on('sync-list-ports', function (event) {
        SerialPort.list(function (err, ports) {
            if (err) {
                event.returnValue = [];
                return;
            }
            event.returnValue = ports;
        });
    });

    ipc.on('start-flash', function (event, arg) {
        // Reading and parsing the .hex file in order to create the data buffer
        const HEX_FILENAME = arg.hexFilename;
        var dataBuffer = fs.readFileSync(HEX_FILENAME, 'utf8');
        try {
            dataBuffer = intelHex.parse(dataBuffer).data;
        } catch (error) {
            win.webContents.send('process-status', { 'type': 'error', 'msg': 'Hex file has invalid format' });
            return;
        }

        var commands = ['sync', 'bankErase', 'download', 'sendData', 'reset']; // sequence of flashing commands
        const MAX_DATA_PACKET_LOAD = 252; // in bytes, 3 command bytes + 252 data bytes = 255 of maximum transfered bytes for sendData command
        const totalDataPackets = parseInt(dataBuffer.length / MAX_DATA_PACKET_LOAD); var dataPacketIndex = 0; // both are used for zero based indexing in data buffer
        const totalProcessSteps = 3 + (totalDataPackets + 1) + 1; // sequence of responses: sync, bankErase, download, sendData*(totalDataPackets + 1), reset
        var progressUpdater, curProcessStep = 0; // interval for updating the progress bar
        var watchdogTimer, watchdogTimeout = 2000; // timer for stopping the flashing process if timeout occurs

        // Initializing serial port and its events and starting the flashing process
        const SERIAL_PORT = arg.port;
        const SERIAL_BAUDRATE = arg.baudRate;
        const port = new SerialPort(SERIAL_PORT, { baudRate: SERIAL_BAUDRATE, autoOpen: false });
        port.open(function (err) {
            if (err) {
                win.webContents.send('process-status', { 'type': 'error', 'msg': err.message });
                return;
            }

            win.webContents.send('process-status', { 'type': 'log', 'log': '\n' + '-- Firmware flashing has started! --' + '\n|\t' + 'Serial port ' + SERIAL_PORT + ' with baud rate ' + SERIAL_BAUDRATE + ' is open!' });
            startFlashProcess();
        });

        // Runtime serial errors will be emitted as an error event
        port.on('error', function (err) {
            win.webContents.send('process-status', { 'type': 'error', 'msg': err.message, 'log': '|\t' + 'Error: ' + err.message });
        });

        // Receiving response bytes from bootloader
        port.on('data', function (data) {
            console.log('For', commands[0], 'Received:', data);
            var lastByte = data[data.length - 1];
            if (lastByte !== 0xcc) { // checking for NACK response byte to stop the process
                if (lastByte === 0x00) { // in different baud rates, the data buffer might be filled either in once (e.g. <Buffer 00 cc>), or sequentially (e.g. first <Buffer 00>, then <Buffer cc>)
                    return;
                }
                return stopFlashProcess();
            }

            restartWatchdogTimer(watchdogTimeout); // restarting watchdog timer in every response
            curProcessStep++;
            if (commands[0] !== 'sendData') {
                win.webContents.send('process-status', { 'type': 'log', 'log': '|\t' + '✓ Command "' + commands[0] + '"' });
                commands.splice(0, 1);
                if (commands[0] === 'sendData') {
                    win.webContents.send('process-status', { 'type': 'log', 'log': '|\t' + 'Start sending ' + (totalDataPackets + 1) + ' data packets:' });
                }
            } else {
                dataPacketIndex++;
                win.webContents.send('process-status', { 'type': 'log', 'log': '|\t' + 'Sent ' + dataPacketIndex + '/' + (totalDataPackets + 1) + ' data packets' });
                if (dataPacketIndex > totalDataPackets) {
                    win.webContents.send('process-status', { 'type': 'log', 'log': '|\t' + '✓ Command "' + commands[0] + '"' });
                    commands.splice(0, 1);
                }
            }

            // Sending next command to bootloader
            if (commands.length) {
                port.write(bufferFromCommand(commands[0]));
            }
        });


        // HELPER FUNCTIONS //
        function bufferFromCommand(command) {
            if (command === 'sync') {
                return Buffer.from([0x55, 0x55]);
            } else if (command === 'download') {
                var bytes = [0x0b, 0x21, 0x00, 0x00, 0x00, 0x00];
                var hexSize = ('0000000' + dataBuffer.length.toString(16)).slice(-8);
                for (var i = 0; i < hexSize.length; i += 2) {
                    bytes.push(parseInt(hexSize.substr(i, 2), 16));
                }
                bytes.splice(1, 0, computeChecksum(bytes));
                return Buffer.from(bytes);
            } else if (command === 'bankErase') {
                return Buffer.from([0x03, 0x2c, 0x2c]);
            } else if (command === 'sendData') {
                var bytes = [], dataSize;
                if (dataPacketIndex < totalDataPackets) {
                    dataSize = MAX_DATA_PACKET_LOAD;
                } else {
                    dataSize = dataBuffer.length % MAX_DATA_PACKET_LOAD;
                }
                bytes.push(dataSize + 3);
                bytes.push(0x24); // command
                for (var i = 0; i < dataSize; i++) {
                    bytes.push(dataBuffer[dataPacketIndex * MAX_DATA_PACKET_LOAD + i]);
                }
                bytes.splice(1, 0, computeChecksum(bytes));
                return Buffer.from(bytes);
            } else if (command === 'reset') {
                return Buffer.from([0x03, 0x25, 0x25]);
            }
        }

        function mapInt(num, in_min, in_max, out_min, out_max) {
            return parseInt((num - in_min) * (out_max - out_min) / (in_max - in_min) + out_min);
        }

        function computeChecksum(bytes) {
            var checksum = 0;
            for (var i = 1; i < bytes.length; i++) {
                checksum += bytes[i];
            }
            return checksum;
        }

        function startFlashProcess() {
            win.webContents.send('process-status', { 'type': 'log', 'log': '|\t' + 'Start executing commands:' });
            port.write(bufferFromCommand(commands[0]));
            startWatchdogTimer(watchdogTimeout);
            progressUpdater = setInterval(() => {
                win.webContents.send('process-status', { 'type': 'progress', 'percent': mapInt(curProcessStep, 0, totalProcessSteps, 0, 100) });
            }, 500);
        }

        function stopFlashProcess() {
            clearInterval(progressUpdater);
            stopWatchdogTimer();

            if (curProcessStep !== totalProcessSteps) {
                win.webContents.send('process-status', { 'type': 'error', 'msg': 'Flashing process failed!', 'log': '|\t' + 'Flashing process failed!' });
            } else {
                win.webContents.send('process-status', { 'type': 'success', 'msg': 'Flashing process has been successfully completed!', 'log': '|\t' + 'Flashing process has been successfully completed!' });
            }

            win.webContents.send('process-status', { 'type': 'log', 'log': '|\t' + 'Closing serial port...' });
            port.close();
        }

        function startWatchdogTimer(timeout) {
            watchdogTimer = setTimeout(() => {
                stopFlashProcess();
            }, timeout);
        }

        function stopWatchdogTimer() {
            clearTimeout(watchdogTimer);
        }

        function restartWatchdogTimer(timeout) {
            stopWatchdogTimer();
            startWatchdogTimer(timeout);
        }
    });

    // Emitted when the window is closed.
    win.on('closed', () => {
        // Dereference the window object, usually you would store windows
        // in an array if your app supports multi windows, this is the time
        // when you should delete the corresponding element.
        win = null;
    });

    win.loadFile('index.html');
}