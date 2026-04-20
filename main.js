const { app, BrowserWindow, BrowserView, ipcMain, session, net, Tray, Menu, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const io = require('socket.io-client');
const fs = require('fs');

// Configurações
// Configurações
const SERVER_URL = 'http://localhost:5000'; 
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Isolamento de Sessão para evitar 'Acesso Negado'
const customDataPath = path.join(app.getPath('appData'), 'imob-bridge-v2-data');
app.setPath('userData', customDataPath);

let mainWindow = null;
let whatsappView = null;
let tray = null;
let socket = null;
let isQuitting = false;
let motorInjected = false; 
let lastMotorSize = 0;
const motorPath = path.join(__dirname, 'ota-engine', 'bridge_motor_v10.js');

function createTray() {
    try {
        let iconPath = path.join(__dirname, 'icon.png');
        if (!fs.existsSync(iconPath)) iconPath = path.join(__dirname, 'Lugar Exato.png');

        if (!fs.existsSync(iconPath)) return;

        tray = new Tray(iconPath);
        const contextMenu = Menu.buildFromTemplate([
            { label: 'Lugar Exato Bridge Console', enabled: false },
            { type: 'separator' },
            { label: 'Abrir Console Premium', click: () => {
                if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
            }},
            { type: 'separator' },
            { label: 'Status: Desconectado', id: 'status-menu', enabled: false },
            { type: 'separator' },
            { label: 'Sair e Encerrar Automação', click: () => {
                isQuitting = true;
                app.quit();
            }}
        ]);
        tray.setToolTip('Lugar Exato Bridge');
        tray.setContextMenu(contextMenu);
    } catch (err) { console.error('Tray Error:', err); }
}

function updateTrayStatus(status) {
    if (!tray) return;
    
    // Electron Tray não possui getContextMenu(). 
    // A forma mais estável de atualizar é definir o menu novamente.
    const statusLabel = status === 'online' ? 'Status: ONLINE 🟢' : 'Status: Desconectado 🔴';
    
    const contextMenu = Menu.buildFromTemplate([
        { label: 'Lugar Exato Bridge Console', enabled: false },
        { type: 'separator' },
        { label: 'Abrir Console Premium', click: () => {
            if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
        }},
        { type: 'separator' },
        { label: statusLabel, enabled: false },
        { type: 'separator' },
        { label: 'Sair e Encerrar Automação', click: () => {
            isQuitting = true;
            app.quit();
        }}
    ]);

    tray.setContextMenu(contextMenu);
}

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 850,
        minWidth: 1000,
        minHeight: 700,
        title: 'Lugar Exato Bridge - Console Premium',
        icon: path.join(__dirname, 'Lugar Exato.png'),
        backgroundColor: '#0b141a',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    mainWindow.loadFile('index.html');

    // Inicializa a View do WhatsApp
    setupWhatsAppView();

    mainWindow.on('close', (event) => {
        if (!isQuitting) {
            event.preventDefault();
            mainWindow.hide();
        }
    });

    mainWindow.webContents.on('did-finish-load', () => {
        const configPath = path.join(app.getPath('userData'), 'config.json');
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath));
            mainWindow.webContents.send('current-token', config.token);
            if (config.token) setupSocket();
        }
    });

    mainWindow.on('resize', () => {
        if (whatsappView && mainWindow.getBrowserView()) {
            updateWhatsAppBounds();
        }
    });
}

function setupWhatsAppView() {
    whatsappView = new BrowserView({
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: false,
            nodeIntegration: false,
            webSecurity: false // Necessário p/ o motor de automação ler o DOM livremente
        }
    });

    whatsappView.webContents.setUserAgent(CHROME_UA);

    // Remove CSP para permitir a injeção do motor no Main World
    whatsappView.webContents.session.webRequest.onHeadersReceived((details, callback) => {
        const responseHeaders = Object.assign({}, details.responseHeaders);
        ['content-security-policy', 'x-frame-options'].forEach(header => {
            delete responseHeaders[header];
            delete responseHeaders[header.toLowerCase()];
        });
        callback({ cancel: false, responseHeaders });
    });

    whatsappView.webContents.loadURL('https://web.whatsapp.com');

    whatsappView.webContents.on('did-finish-load', async () => {
        const currentURL = whatsappView.webContents.getURL();
        if (!currentURL.includes('web.whatsapp.com')) return;
        checkAndInject();
    });

    // Encaminhador de Console do Navegador para o Terminal de Diagnóstico
    whatsappView.webContents.on('console-message', (event, level, message, line, sourceId) => {
        if (!socket || !socket.connected) return;
        const levels = ['LOG', 'WARN', 'ERROR', 'DEBUG'];
        const logMsg = `[BROWSER-${levels[level] || 'INFO'}] ${message} (Linha: ${line})`;
        socket.emit('bridge_log', logMsg);
    });

    whatsappView.webContents.on('did-start-navigation', () => {
        motorInjected = false; 
        isInjecting = false; // Garante que a trava de injeção seja liberada no reload
    });


    // Aguarda carregar e mostra a aba padrão
    setTimeout(() => { switchTab('whatsapp'); }, 1500);
}

let isInjecting = false;
let lastInjectionAttempt = 0;

async function checkAndInject() {
    if (isInjecting && Date.now() - lastInjectionAttempt < 7000) {
        console.log(`[WATCHDOG] Injeção em andamento... (Aguardando Mutex)`);
        return;
    }
    
    console.log(`[WATCHDOG] Verificando estado do motor...`);
    try {
        const url = whatsappView.webContents.getURL();
        if (!url.includes('web.whatsapp.com') || url.includes('/qr')) return;
        
        if (!fs.existsSync(motorPath)) return;
        const stats = fs.statSync(motorPath);
        const currentSize = stats.size;

        // Verificação de versão ativa
        let activeVersion = 0;
        try {
            activeVersion = await whatsappView.webContents.executeJavaScript('window.CURRENT_MOTOR_VERSION || 0');
        } catch(e) { activeVersion = 0; }

        const targetVersion = 9.0;
        console.log(`[WATCHDOG] Analisando Injeção: Ativa=${activeVersion} | Alvo=${targetVersion} | URL=${url}`);

        // Lógica de Atualização Inteligente
        if (activeVersion > 0 && activeVersion !== targetVersion) {
            console.log(`[WATCHDOG] Versão antiga detectada (${activeVersion} -> ${targetVersion}). Atualizando...`);
            lastMotorSize = currentSize;
            motorInjected = false;
            await whatsappView.webContents.session.clearCache();
            whatsappView.webContents.reload();
            return;
        }

        // Caso o arquivo no disco tenha mudado fisicamente
        if (motorInjected && currentSize !== lastMotorSize && lastMotorSize > 0) {
             console.log(`[WATCHDOG] Mudança física no motor. Atualizando...`);
             lastMotorSize = currentSize;
             motorInjected = false;
             whatsappView.webContents.reload();
             return;
        }

        // Caso de injeção necessária
        if (activeVersion < targetVersion) {
            isInjecting = true;
            lastInjectionAttempt = Date.now();
            
            const motorScript = fs.readFileSync(motorPath, 'utf8');
            lastMotorSize = currentSize;
            
            if (socket && socket.connected) {
                socket.emit('bridge_log', `[SYSTEM] Ativando Mapeador v${targetVersion}...`);
            }

            const safeScript = JSON.stringify(motorScript);
            const wrapper = `
                (function() {
                    if (window.CURRENT_MOTOR_VERSION >= ${targetVersion}) return;
                    const script = document.createElement('script');
                    script.textContent = ${safeScript};
                    (document.head || document.documentElement).appendChild(script);
                    script.remove();
                })();
            `;
            console.log(`[WATCHDOG] Enviando script v${targetVersion} para o navegador...`);
            await whatsappView.webContents.executeJavaScript(wrapper);
            console.log(`[WATCHDOG] Comando de injeção enviado com sucesso.`);
            
            setTimeout(() => { isInjecting = false; }, 5000);
            motorInjected = true;
        }
    } catch (e) {
        isInjecting = false;
        console.error('[WATCHDOG ERROR]', e.message);
    }
}

// Watchdog de Estabilidade (15s para dar tempo ao WhatsApp de respirar)
setInterval(checkAndInject, 15000);

function updateWhatsAppBounds() {
    const { width, height } = mainWindow.getContentBounds();
    // Offset do Header Premium (Header ~55px + Tabs ~42px) -> Total ~98px
    whatsappView.setBounds({ x: 0, y: 100, width: width, height: height - 100 });
}

function switchTab(tab) {
    if (!mainWindow || !whatsappView) return;

    if (tab === 'whatsapp') {
        mainWindow.setBrowserView(whatsappView);
        updateWhatsAppBounds();
    } else {
        mainWindow.setBrowserView(null);
    }
}

function setupSocket() {
    try {
        if (socket) { socket.close(); socket = null; }

        const configPath = path.join(app.getPath('userData'), 'config.json');
        if (!fs.existsSync(configPath)) return;
        const config = JSON.parse(fs.readFileSync(configPath));
        if (!config.token) return;

        console.log('Tentando Conexão com:', config.token);

        socket = io(SERVER_URL, {
            auth: { token: config.token },
            query: { token: config.token },
            transports: ['websocket'],
            reconnection: true,
            forceNew: true 
        });

        socket.on('connect', () => {
            console.log('Socket Conectado');
            updateTrayStatus('online');
            if (mainWindow) {
                mainWindow.webContents.send('status-change', 'online');
                mainWindow.webContents.send('log-msg', 'Automação Ativa!');
            }
        });

        socket.on('connect_error', (err) => {
            updateTrayStatus('offline');
            let msg = err.message;
            if (msg === 'xhr poll error' || msg === 'websocket error') msg = 'Servidor Offline ou Erro de Rede';
            
            if (mainWindow) {
                mainWindow.webContents.send('status-change', 'offline');
                mainWindow.webContents.send('log-msg', `CONEXÃO FALHOU: ${msg}`);
            }
        });

        socket.on('whatsapp_outbound', (data) => {
            if (whatsappView) whatsappView.webContents.send('to-whatsapp-motor', data);
        });

        socket.on('disconnect', (reason) => {
            updateTrayStatus('offline');
            if (mainWindow) {
                mainWindow.webContents.send('status-change', 'offline');
                mainWindow.webContents.send('log-msg', `Desconectado: ${reason}`);
            }
        });

    } catch (err) { console.error('Socket Setup Error:', err); }
}

// IPC Handlers
ipcMain.on('switch-tab', (event, tab) => switchTab(tab));

ipcMain.on('reload-whatsapp', () => {
    if (whatsappView) {
        whatsappView.webContents.reload();
    }
});

ipcMain.on('stop-socket', () => {
    if (socket) {
        socket.disconnect();
        socket = null;
        updateTrayStatus('offline');
        if (mainWindow) {
            mainWindow.webContents.send('status-change', 'offline');
            mainWindow.webContents.send('log-msg', 'Automação interrompida manualmente.');
        }
    }
});

ipcMain.on('save-token', (event, token) => {
    const configPath = path.join(app.getPath('userData'), 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ token }));
    setupSocket();
});

ipcMain.on('from-whatsapp-motor', (event, data) => {
    if (data.type === 'ready') {
        motorInjected = true;
        if (mainWindow) mainWindow.webContents.send('log-msg', '🚀 Motor Injetado com Sucesso!');
        return;
    }

    if (data.type === 'heartbeat') {
        if (data.status === 'waiting') {
            motorInjected = false; // Força re-injeção pelo watchdog
        }
        if (mainWindow) mainWindow.webContents.send('motor-heartbeat');
        return;
    }

    if (data.type === 'log') {
        if (socket && socket.connected) {
            socket.emit('bridge_log', data.message);
        }
        return;
    }

    if (socket && socket.connected) {
        if (data.type === 'sent_confirm') {
            socket.emit('whatsapp_sent', data);
            return;
        }

        if (data.event === 'messages.upsert') {
            if (mainWindow) mainWindow.webContents.send('log-msg', `Capturado do WhatsApp: ${data.data?.message?.conversation || 'Mídia/Outro'}`);
        }
        socket.emit('whatsapp_inbound', data);
    }
});

app.whenReady().then(() => {
    session.defaultSession.setUserAgent(CHROME_UA);
    createTray();
    createMainWindow();
    
    // Auto Updater Setup
    autoUpdater.autoDownload = true; // Download silently in background
    autoUpdater.checkForUpdatesAndNotify();

    autoUpdater.on('update-available', () => {
        if (mainWindow) mainWindow.webContents.send('log-msg', 'Nova atualização encontrada. Baixando silenciosamente...');
    });

    autoUpdater.on('update-downloaded', () => {
        if (mainWindow) mainWindow.webContents.send('log-msg', 'Atualização pronta para instalação.');
        
        dialog.showMessageBox({
            type: 'info',
            title: 'Atualização Pronta',
            message: 'Uma nova versão do Lugar Exato Bridge foi baixada. Deseja reiniciar e instalar a atualização agora?',
            buttons: ['Reiniciar e Atualizar', 'Mais Tarde']
        }).then((result) => {
            if (result.response === 0) {
                isQuitting = true;
                autoUpdater.quitAndInstall();
            }
        });
    });

    autoUpdater.on('error', (err) => {
        console.error('Erro na atualização:', err);
    });
});

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
    });
}

app.on('before-quit', () => {
    isQuitting = true;
    if (tray) {
        tray.destroy();
        tray = null;
    }
});

app.on('window-all-closed', () => { /* Background mode */ });
app.on('activate', () => { if (mainWindow === null) createMainWindow(); });
