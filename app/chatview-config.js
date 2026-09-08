    window.bedrockChatRuntimeConfig = {};
    window.bedrockChatConfig = async function () {
      try {
        var r = await fetch('/app-config?app=chat', { cache: 'no-store' });
        if (!r.ok) return window.bedrockChatRuntimeConfig;
        var data = await r.json();
        var opts = (data && data.options) || {};
        window.bedrockChatRuntimeConfig = {
          endpoint: opts.endpoint || '',
          apiKey: opts.api_key || '',
          model: opts.model || ''
        };
      } catch (e) {
        window.bedrockChatRuntimeConfig = {};
      }
      return window.bedrockChatRuntimeConfig;
    };
