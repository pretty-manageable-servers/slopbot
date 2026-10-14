/**
 * Short sound cues for voice sessions. They are made in code as Discord PCM: 48 kHz, stereo, 16-bit little endian.
 * No files and no TTS. They are built once, when this module loads.
 */

const RATE = 48000;
const CHANNELS = 2;
const AMPLITUDE = 0.18;
const FADE_MS = 5;
const FULL_SCALE = 32767;

interface Segment { ms: number; hz?: number }

function frameCount(ms: number): number { return Math.round(RATE * ms / 1000); }

/** Linear fade in and out, so a note starts and ends at zero. */
function envelope(index: number, count: number, fade: number): number {
  return Math.min(1, index / fade, (count - 1 - index) / fade);
}

/** Renders segments in order. A segment without `hz` is silence. */
function render(segments: readonly Segment[]): Buffer {
  const frames = segments.reduce((sum, segment) => sum + frameCount(segment.ms), 0);
  const pcm = Buffer.alloc(frames * CHANNELS * 2);
  const fade = frameCount(FADE_MS);
  let frame = 0;
  for (const { ms, hz } of segments) {
    const count = frameCount(ms);
    for (let index = 0; index < count; index++, frame++) {
      const level = hz === undefined ? 0 : Math.sin(2 * Math.PI * hz * index / RATE) * envelope(index, count, fade);
      const sample = Math.round(AMPLITUDE * FULL_SCALE * level);
      // The same sample goes to both channels: the cue is centred.
      for (let channel = 0; channel < CHANNELS; channel++) pcm.writeInt16LE(sample, (frame * CHANNELS + channel) * 2);
    }
  }
  return pcm;
}

/** One soft blip: a 880 Hz note of 90 ms. Played when a turn starts. */
export const HEARD_CUE: Buffer = render([{ hz: 880, ms: 90 }]);

/** Two rising notes, 660 Hz then 990 Hz, 90 ms each with a 30 ms gap. Played when a turn ends. */
export const READY_CUE: Buffer = render([{ hz: 660, ms: 90 }, { ms: 30 }, { hz: 990, ms: 90 }]);
