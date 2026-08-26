(function(){
    const VERSION = '2026.07.04.rec-ui.1';
    const scripts = [
        '/smart-canvas-core/i18n-core.js',
        '/smart-canvas-core/i18n/common.js',
        '/smart-canvas-core/i18n/studio.js',
        '/smart-canvas-core/i18n/api-settings.js',
        '/smart-canvas-core/i18n/canvas.js',
        '/smart-canvas-core/i18n/smart-canvas.js',
        '/smart-canvas-core/i18n/comfyui-settings.js',
        '/smart-canvas-core/i18n/pages.js',
    ];
    const tags = scripts.map(src => '<script src="' + src + '?v=' + VERSION + '"></script>').join('');
    if(document.readyState === 'loading' && document.currentScript){
        document.write(tags);
        return;
    }
    scripts.reduce((promise, src) => promise.then(() => new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src + '?v=' + VERSION;
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
    })), Promise.resolve()).then(() => window.StudioI18n?.apply?.()).catch(err => console.error('Failed to load i18n modules', err));
})();
