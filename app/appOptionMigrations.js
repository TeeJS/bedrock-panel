'use strict';

function migrateAppOptions(config) {
  (config.grids || []).forEach(grid => {
    if (!grid || grid.kind !== 'app' || grid.app !== 'ai-usage' || !grid.options) return;
    const options = grid.options;
    if (!Object.prototype.hasOwnProperty.call(options, 'copilotCreditsIncluded')
        && Object.prototype.hasOwnProperty.call(options, 'copilotIncluded')) {
      // The old field counted premium requests. Only the 1,500 tier still maps to a
      // personal AI-credit allowance; retired Business/Enterprise values become
      // unknown so the app does not show a misleading gauge.
      options.copilotCreditsIncluded = String(options.copilotIncluded) === '1500' ? '1500' : '0';
    }
    delete options.copilotIncluded;
  });
  return config;
}

module.exports = { migrateAppOptions };
