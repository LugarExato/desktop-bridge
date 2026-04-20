/**
 * BRIDGE MOTOR v9.0 - [FULL MESSAGE ENGINE]
 * Integracao Nativa via window.require
 * 
 * FIX: Constroi um objeto de mensagem completo (MsgKey + Metadados) para o addAndSendMsgToChat.
 * FIX: Evita o erro 'Cannot read properties of undefined (reading remote)'.
 */

(function() {
    const MY_VERSION = 9.0;
    const INSTANCE_ID = Math.random().toString(36).substring(7);
    window.Store = window.Store || {};

    if (window.MOTORS_ACTIVE) window.MOTORS_ACTIVE.forEach(i => clearInterval(i));
    window.MOTORS_ACTIVE = [];
    window.CURRENT_MOTOR_VERSION = MY_VERSION;

    function remoteLog(msg) {
        console.log(`[Motor v${MY_VERSION.toFixed(1)}] ${msg}`);
        if (window.bridge) window.bridge.sendToVPS({ type: 'log', message: `[${INSTANCE_ID}] ${msg}` });
    }

    remoteLog(`📡 MOTOR v9.0 [FULL ENGINE] INICIADO! ID: ${INSTANCE_ID}`);

    if (window.bridge) {
        window.bridge.sendToVPS({ type: 'ready' });
    }

    const pulse = setInterval(() => {
        const found = !!(window.Store && window.Store.Msg && window.Store.Chat);
        if (window.bridge) {
            window.bridge.sendToVPS({ type: 'heartbeat', status: found ? 'active' : 'waiting' });
        }
    }, 5000);
    window.MOTORS_ACTIVE.push(pulse);

    function normalizeJid(jid) {
        if (!jid || typeof jid !== 'string') return jid;
        let cleaned = jid.replace('+', '').trim();
        if (cleaned.endsWith('@s.whatsapp.net')) cleaned = cleaned.replace('@s.whatsapp.net', '@c.us');
        if (!cleaned.includes('@')) cleaned = `${cleaned}@c.us`;
        return cleaned;
    }

    function getOrCreateWid(jidStr) {
        const normalized = normalizeJid(jidStr);
        if (window.Store.WidFactory) {
            try { return window.Store.WidFactory.createWid(normalized); } catch(e) {}
        }
        if (window.Store.UserConstructor) {
            try { return new window.Store.UserConstructor(normalized); } catch(e) {}
        }
        if (normalized.length > 15 && normalized.endsWith('@c.us')) {
            const lid = normalized.replace('@c.us', '@lid');
            if (window.Store.WidFactory) {
                try { return window.Store.WidFactory.createWid(lid); } catch(e) {}
            }
        }
        return normalized;
    }

    function reportMsg(m) {
        if (!m || !m.id) return;
        const text = m.body || m.caption;
        if (!text) return;
        if (window.LAST_MSG_ID === m.id._serialized) return;
        window.LAST_MSG_ID = m.id._serialized;
        
        remoteLog(`CAPTURA MSG WAPI: ${text}`);
        if (window.bridge) {
            const remoteStr = (m.id.remote && typeof m.id.remote === 'object' && m.id.remote._serialized) 
                               ? m.id.remote._serialized 
                               : m.id.remote;

            window.bridge.sendToVPS({
                event: 'messages.upsert',
                instance: 'desktop_bridge',
                data: {
                    key: { id: m.id.id || m.id._serialized, remoteJid: normalizeJid(remoteStr), fromMe: m.id.fromMe || false },
                    message: { conversation: text },
                    pushName: m.senderObj?.pushname || m.senderObj?.name || 'Cliente',
                    messageType: 'conversation'
                }
            });
        }
    }

    /**
     * Constroi o objeto de mensagem complexo exigido pelo WA Web
     */
    async function buildMessageObject(chat, content) {
        const meUser = window.Store.User.getMaybeMeLidUser() || window.Store.User.getMaybeMePnUser() || window.Store.User.getMeUser();
        const newId = (window.Store.MsgKey && window.Store.MsgKey.newId) ? await window.Store.MsgKey.newId() : Math.random().toString(36).substring(2, 15);
        
        const newMsgKey = new window.Store.MsgKey({
            from: meUser,
            to: chat.id,
            id: newId,
            selfDir: 'out',
        });

        const ephemeralFields = window.Store.EphemeralFields ? window.Store.EphemeralFields.getEphemeralFields(chat) : {};

        return {
            id: newMsgKey,
            ack: 0,
            body: content,
            from: meUser,
            to: chat.id,
            local: true,
            self: 'out',
            t: parseInt(new Date().getTime() / 1000),
            isNewMsg: true,
            type: 'chat',
            ...ephemeralFields
        };
    }

    function findStore() {
        try {
            if (typeof window.require === 'undefined') return false;

            if (!window.Store.WidFactory) { try { window.Store.WidFactory = window.require('WAWebWidFactory'); } catch(e) {} }
            if (!window.Store.UserConstructor) { try { window.Store.UserConstructor = window.require('WAWebWid'); } catch(e) {} }
            if (!window.Store.MsgKey) { try { window.Store.MsgKey = window.require('WAWebMsgKey'); } catch(e) {} }
            if (!window.Store.User) { try { window.Store.User = window.require('WAWebUserPrefsMeUser'); } catch(e) {} }
            if (!window.Store.EphemeralFields) { try { window.Store.EphemeralFields = window.require('WAWebGetEphemeralFieldsMsgActionsUtils'); } catch(e) {} }

            if (!window.Store.Msg || !window.Store.Chat) {
                const collections = window.require('WAWebCollections');
                if (collections && collections.Msg && collections.Chat) {
                    window.Store.Msg = collections.Msg;
                    window.Store.Chat = collections.Chat;
                    if (window.Store.Chat.modelClass) window.Store.ChatModel = window.Store.Chat.modelClass;

                    if (window.Store.Chat && !window.Store.Chat.findImpl) {
                        window.Store.Chat.findImpl = (e) => {
                            const chat = window.Store.Chat.get(e);
                            if (chat) return Promise.resolve(chat);
                            const wid = getOrCreateWid((typeof e === 'object' && e._serialized) ? e._serialized : e);
                            if (window.Store.ChatModel) {
                                try { return Promise.resolve(new window.Store.ChatModel({ id: wid })); } catch(err) {}
                            }
                            return Promise.resolve({ id: wid });
                        };
                    }
                }
            }

            if (!window.Store.FindChat) { try { window.Store.FindChat = window.require('WAWebFindChatAction'); } catch(e) {} }

            if (!window.Store.SendText) {
                try {
                    const chatAction = window.require('WAWebSendMsgChatAction');
                    window.Store.SendText = chatAction.addAndSendMsgToChat || chatAction.sendTextMsgToChat;
                } catch(e) {}
            }

            return !!(window.Store.Msg && window.Store.Chat && window.Store.SendText && window.Store.MsgKey && window.Store.User);

        } catch(e) {
            remoteLog('Erro CRITICO no mapeamento: ' + e.message);
            return false;
        }
    }

    async function internalSendMessage(number, text) {
        try {
            if (!window.Store.Chat || !window.Store.SendText) {
                remoteLog('Erro: SendText ou Chat indisponível.');
                return;
            }
            
            const wid = getOrCreateWid(number);
            let chat = window.Store.Chat.get(wid);
            
            if (!chat) {
                if (window.Store.FindChat && window.Store.FindChat.findChat) {
                    const result = await window.Store.FindChat.findChat(wid);
                    chat = result ? result.chat : null;
                } else if (window.Store.Chat.find) {
                    chat = await window.Store.Chat.find(wid);
                }
            }
            
            if (chat) {
                const messageObj = await buildMessageObject(chat, text);
                await window.Store.SendText(chat, messageObj);
                const msgId = messageObj.id.id || messageObj.id._serialized || messageObj.id;
                remoteLog(`Sucesso: Enviado para ${number} (ID: ${msgId})`);
                if (window.bridge) {
                    window.bridge.sendToVPS({ type: 'sent_confirm', message_id: msgId, number: number });
                }
            } else {
                remoteLog(`Erro: Chat ${number} nao encontrado.`);
            }
        } catch (err) {
            remoteLog('Erro CRITICO no envio: ' + err.message);
        }
    }

    function init() {
        if (window.WAPI_INITIALIZED && window.WAPI_VER === MY_VERSION) return;
        if (findStore()) {
            remoteLog('💎 NATIVE WAPI OPERANTE (v9.0 + FULL ENGINE)!');
            window.WAPI_INITIALIZED = true;
            window.WAPI_VER = MY_VERSION;

            function processNewMessage(m) {
                if (!m || !m.id) return;
                try {
                    const serialized = typeof m.serialize === 'function' ? m.serialize() : m;
                    reportMsg(serialized);
                } catch (e) {
                    remoteLog('Erro processando Msg: ' + e.message);
                }
            }

            if (window.Store.Msg && typeof window.Store.Msg.on === 'function') {
                window.Store.Msg.off('add'); 
                window.Store.Msg.on('add', (m) => {
                    if (!m.isNewMsg) return;
                    if (m.type === 'ciphertext') {
                        m.once('change:type', (msgDecrypted) => processNewMessage(msgDecrypted));
                    } else {
                        processNewMessage(m);
                    }
                });
            }
        } else {
            setTimeout(init, 5000);
        }
    }

    init();

    if (window.bridge) {
        window.bridge.onOutbound((data) => {
            if (data.type === 'text') {
                internalSendMessage(data.payload.number, data.payload.text);
            }
        });
    }

})();
