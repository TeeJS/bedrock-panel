    import ChatWidget, { mount } from './ChatWidget.js';
    const cfg = await window.bedrockChatConfig();
    if (!(cfg.apiKey && cfg.endpoint)) {
      document.getElementById('nokey').style.display = 'flex';
    }
    mount(ChatWidget, { target: document.getElementById('chat-widget') });
