const { ipcRenderer } = require('electron');

// Expõe uma API mínima para o motor injetado
window.bridge = {
    sendToVPS: (data) => {
        ipcRenderer.send('from-whatsapp-motor', data);
    },
    onOutbound: (callback) => {
        ipcRenderer.on('to-whatsapp-motor', (event, data) => {
            callback(data);
        });
    }
};

console.log('[Bridge] Preload carregado com sucesso.');
