/**
 * BRIDGE MOTOR v2.10 - [ULTIMATE-DNA]
 * Intercepta mensagens e mapeia o motor interno do WhatsApp de forma comportamental.
 */

(function() {
    window.Store = window.Store || {};

    // PROTOCOLO DE EXTERMÍNIO
    if (window.MOTORS_ACTIVE) {
        window.MOTORS_ACTIVE.forEach(interval => clearInterval(interval));
    }
    window.MOTORS_ACTIVE = [];

    function remoteLog(msg) {
        console.log(`[Motor v2.10] ${msg}`);
        if (window.bridge) {
            window.bridge.sendToVPS({ type: 'log', message: msg });
        }
    }

    // SINAL DE BOOTSTRAP IMEDIATO
    remoteLog('🚀 MOTOR BOOTSTRAP: v2.10 [ULTIMATE] Iniciado!');

    if (window.bridge) {
        window.bridge.sendToVPS({ type: 'ready' });
    }

    // 1. Scanner de DNA Exaustivo
    function findStoreByDNA() {
        const globals = Object.getOwnPropertyNames(window);
        
        // Estratégia A: Busca por nomes conhecidos (Webpack)
        let namespace = globals.find(key => 
            (key.startsWith('webpackChunk') || key.includes('Chunk') || key.includes('webpack')) && 
            Array.isArray(window[key]) && window[key].push
        );
        if (namespace) return { win: window, namespace };

        // Estratégia B: Busca comportamental por Arrays que aceitam push
        let candidates = globals.filter(key => {
            try {
                return Array.isArray(window[key]) && window[key].length > 10 && window[key].push;
            } catch(e) { return false; }
        });

        if (candidates.length > 0) {
            remoteLog(`Candidatos detectados: ${candidates.join(', ')}`);
            namespace = candidates.find(c => !['chrome', 'App', 'MOTORS_ACTIVE'].includes(c));
            if (namespace) return { win: window, namespace };
        }

        // Estratégia C: Store já exposto
        let direct = globals.find(key => window[key] && window[key].Msg && window[key].Chat);
        if (direct) return { win: window, namespace: direct, isDirect: true };

        return null;
    }

    function initStore() {
        if (window.Store && window.Store.Msg && window.Store.Chat) return true;

        try {
            let discovery = findStoreByDNA();
            if (!discovery) {
                remoteLog('Aguardando inicialização dos módulos do WhatsApp...');
                return false;
            }

            const targetWin = discovery.win;
            const webpackNamespace = discovery.namespace;

            if (discovery.isDirect) {
                window.Store = targetWin[webpackNamespace];
                remoteLog('DNA Detectado: Store mapeado diretamente.');
                if (window.Store.Msg) startListening();
                return true;
            }

            remoteLog(`Barramento detectado: ${webpackNamespace}. Capturando 'require'...`);

            let foundFunc = null;
            try {
                const injectionId = "ag_" + Math.random().toString(36).substr(2, 9);
                targetWin[webpackNamespace].push([
                    [injectionId],
                    {},
                    (e) => { foundFunc = e; }
                ]);
            } catch (e) {
                remoteLog(`Erro ao injetar no Namespace: ${e.message}`);
                return false;
            }

            if (!foundFunc) return false;

            const modules = foundFunc.m;
            for (let id in modules) {
                try {
                    const module = foundFunc(id);
                    if (!module) continue;

                    if (!window.Store.Msg && module.default && module.default.Msg && module.default.Msg.on) {
                        window.Store.Msg = module.default.Msg;
                        remoteLog('Store.Msg encontrado!');
                    }
                    if (!window.Store.Chat && module.default && module.default.Chat && module.default.Chat.get) {
                        window.Store.Chat = module.default.Chat;
                        remoteLog('Store.Chat encontrado!');
                    }
                    if (!window.Store.SendText && (module.sendTextMsgToChat || module.default?.sendTextMsgToChat)) {
                        window.Store.SendText = module.sendTextMsgToChat || module.default.sendTextMsgToChat;
                        remoteLog('Store.SendText encontrado!');
                    }
                } catch (e) {}
            }

            if (window.Store.Msg && window.Store.Chat) {
                remoteLog('MAPEAMENTO CONCLUÍDO COM SUCESSO!');
                startListening();
                return true;
            }
        } catch (err) {
            remoteLog('ERRO no initStore: ' + err.message);
        }
        return false;
    }

    function startListening() {
        if (!window.Store.Msg) return;
        remoteLog('Iniciando ouvintes de mensagem...');
        
        window.Store.Msg.on('add', (msg) => {
            try {
                if (msg.id.fromMe || msg.isStatusV3) return;
                if (msg.type === 'chat' && msg.body) {
                    remoteLog(`MENSAGEM: ${msg.body}`);
                    if (window.bridge) {
                        window.bridge.sendToVPS({
                            event: 'messages.upsert',
                            instance: 'desktop_bridge',
                            data: {
                                key: { id: msg.id._serialized, remoteJid: msg.id.remote, fromMe: false },
                                message: { conversation: msg.body },
                                pushName: msg.pushname || 'Cliente',
                                messageType: 'conversation'
                            }
                        });
                    }
                }
            } catch (err) {}
        });
    }

    async function internalSendMessage(number, text) {
        try {
            if (!window.Store.Chat || !window.Store.SendText) return;
            const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;
            let chat = window.Store.Chat.get(jid);
            if (!chat) chat = await window.Store.Chat.find(jid);
            if (chat) await window.Store.SendText(chat, text);
        } catch (err) {
            remoteLog('Erro no envio interno: ' + err.message);
        }
    }

    const intervalId = setInterval(() => {
        if (initStore()) { }
    }, 4000);
    window.MOTORS_ACTIVE.push(intervalId);

    if (window.bridge) {
        window.bridge.onOutbound((data) => {
            if (data.type === 'text') {
                internalSendMessage(data.payload.number, data.payload.text);
            }
        });
    }

})();
