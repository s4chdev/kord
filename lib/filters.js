const FILTER_PRESETS = [
  'off', 'bassboost', 'nightcore', 'vaporwave', '8d', 'karaoke', 'vibrato', 'tremolo',
  'distortion', 'lofi', 'highpass', 'slowed', 'chipmunk', 'mono', 'treble', 'deep',
  'fast', 'vocalboost', 'basstreble', 'radio', 'left', 'right'
];

const FILTER_LABELS = {
  off: 'Off',
  bassboost: 'Bassboost',
  nightcore: 'Nightcore',
  vaporwave: 'Vaporwave',
  '8d': '8D',
  karaoke: 'Karaoke',
  vibrato: 'Vibrato',
  tremolo: 'Tremolo',
  distortion: 'Distortion',
  lofi: 'LoFi',
  highpass: 'Highpass',
  slowed: 'Slowed',
  chipmunk: 'Chipmunk',
  mono: 'Mono',
  treble: 'Treble',
  deep: 'Deep',
  fast: 'Fast',
  vocalboost: 'Vocal boost',
  basstreble: 'Bass + treble',
  radio: 'Radio',
  left: 'Left channel',
  right: 'Right channel'
};

async function applyFilterPreset(player, preset) {
  if (!player) return;

  if (preset === 'off') {
    await player.setFilters({});
    return;
  }

  if (preset === 'bassboost') {
    await player.setFilters({
      equalizer: [
        { band: 0, gain: 0.25 },
        { band: 1, gain: 0.25 },
        { band: 2, gain: 0.2 },
        { band: 3, gain: 0.15 }
      ]
    });
  } else if (preset === 'nightcore') {
    await player.setFilters({ timescale: { speed: 1.1, pitch: 1.1, rate: 1.0 } });
  } else if (preset === 'vaporwave') {
    await player.setFilters({ timescale: { speed: 0.85, pitch: 0.9, rate: 1.0 } });
  } else if (preset === '8d') {
    await player.setFilters({ rotation: { rotationHz: 0.2 } });
  } else if (preset === 'karaoke') {
    await player.setFilters({
      karaoke: { level: 1.0, monoLevel: 1.0, filterBand: 220.0, filterWidth: 100.0 }
    });
  } else if (preset === 'vibrato') {
    await player.setFilters({ vibrato: { frequency: 6, depth: 0.3 } });
  } else if (preset === 'tremolo') {
    await player.setFilters({ tremolo: { frequency: 4, depth: 0.5 } });
  } else if (preset === 'distortion') {
    await player.setFilters({
      distortion: { sinOffset: 0, sinScale: 1.0, cosOffset: 0, cosScale: 1.0, scale: 0.5 }
    });
  } else if (preset === 'lofi') {
    await player.setFilters({
      timescale: { speed: 0.85, pitch: 0.85, rate: 1.0 },
      lowpass: { smoothing: 20.0, cutoff: 1500.0 }
    });
  } else if (preset === 'highpass') {
    await player.setFilters({ highpass: { smoothing: 20.0, cutoff: 2000.0 } });
  } else if (preset === 'slowed') {
    await player.setFilters({ timescale: { speed: 0.8, pitch: 0.9, rate: 1.0 } });
  } else if (preset === 'chipmunk') {
    await player.setFilters({ timescale: { speed: 1.05, pitch: 1.35, rate: 1.0 } });
  } else if (preset === 'mono') {
    await player.setFilters({
      channelMix: { leftToLeft: 0.5, leftToRight: 0.5, rightToLeft: 0.5, rightToRight: 0.5 }
    });
  } else if (preset === 'treble') {
    await player.setFilters({
      equalizer: [
        { band: 0, gain: -0.05 },
        { band: 1, gain: -0.03 },
        { band: 10, gain: 0.12 },
        { band: 12, gain: 0.18 },
        { band: 14, gain: 0.22 }
      ]
    });
  } else if (preset === 'deep') {
    await player.setFilters({ timescale: { speed: 0.92, pitch: 0.8, rate: 1.0 } });
  } else if (preset === 'fast') {
    await player.setFilters({ timescale: { speed: 1.2, pitch: 1.0, rate: 1.0 } });
  } else if (preset === 'vocalboost') {
    await player.setFilters({
      equalizer: [
        { band: 3, gain: 0.08 },
        { band: 4, gain: 0.12 },
        { band: 5, gain: 0.18 },
        { band: 6, gain: 0.12 },
        { band: 7, gain: 0.08 }
      ]
    });
  } else if (preset === 'basstreble') {
    await player.setFilters({
      equalizer: [
        { band: 0, gain: 0.18 },
        { band: 1, gain: 0.16 },
        { band: 2, gain: 0.12 },
        { band: 6, gain: -0.06 },
        { band: 7, gain: -0.08 },
        { band: 11, gain: 0.12 },
        { band: 13, gain: 0.16 },
        { band: 14, gain: 0.18 }
      ]
    });
  } else if (preset === 'radio') {
    await player.setFilters({
      lowpass: { smoothing: 25.0 },
      highpass: { smoothing: 20.0, cutoff: 260.0 },
      distortion: { sinOffset: 0.02, sinScale: 0.95, cosOffset: 0, cosScale: 0.9, scale: 0.12 }
    });
  } else if (preset === 'left') {
    await player.setFilters({
      channelMix: { leftToLeft: 1, leftToRight: 0, rightToLeft: 1, rightToRight: 0 }
    });
  } else if (preset === 'right') {
    await player.setFilters({
      channelMix: { leftToLeft: 0, leftToRight: 1, rightToLeft: 0, rightToRight: 1 }
    });
  } else {
    throw new Error(`Unknown filter preset: ${preset}`);
  }
}

module.exports = { FILTER_PRESETS, FILTER_LABELS, applyFilterPreset };
