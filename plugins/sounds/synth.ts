// The sounds Sounds makes itself with Web Audio: the built-in effects, and music generated as it
// plays. They need no files and no network, so an event sounds right with nothing uploaded.
import type { Builtin } from "./schedule.ts";

export type MusicStyle = "lofi" | "ambient";

/** A MIDI note's frequency: 69 is A4, 440 Hz. */
const hz = (note: number) => 440 * 2 ** ((note - 69) / 12);

/** A small seeded random, so a bar's arpeggio is varied but never jarring. */
function random(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function tone(
  context: BaseAudioContext,
  bus: AudioNode,
  at: number,
  note: number,
  length: number,
  type: OscillatorType,
  gain: number,
) {
  const oscillator = context.createOscillator();
  const envelope = context.createGain();
  oscillator.type = type;
  oscillator.frequency.value = hz(note);
  envelope.gain.setValueAtTime(0, at);
  envelope.gain.linearRampToValueAtTime(gain, at + 0.012);
  envelope.gain.exponentialRampToValueAtTime(0.0001, at + length);
  oscillator.connect(envelope).connect(bus);
  oscillator.start(at);
  oscillator.stop(at + length + 0.05);
}

/** [start offset in seconds, MIDI note, length in seconds] */
type Note = [number, number, number];

const BUILTIN_NOTES: Record<
  Builtin,
  Tuple<{ notes: Tuple<Note>; type: OscillatorType; gain: number }>
> = {
  // a bright rising third, like a doorbell
  chime: [
    {
      notes: [
        [0, 76, 0.9],
        [0.14, 79, 1.2],
        [0.14, 88, 0.8],
      ],
      type: "sine",
      gain: 0.28,
    },
  ],
  // three insistent beats, then a held note
  alert: [
    {
      notes: [0, 0.22, 0.44].flatMap((offset): Note[] => [
        [offset, 81, 0.18],
        [offset, 88, 0.18],
      ]),
      type: "square",
      gain: 0.08,
    },
    { notes: [[0.7, 84, 0.6]], type: "triangle", gain: 0.25 },
  ],
  // a soft two-note pop
  pop: [
    {
      notes: [
        [0, 83, 0.25],
        [0.08, 88, 0.35],
      ],
      type: "sine",
      gain: 0.2,
    },
  ],
  rise: [
    {
      notes: [
        [0, 72, 0.5],
        [0.12, 79, 0.9],
      ],
      type: "triangle",
      gain: 0.28,
    },
  ],
  fall: [
    {
      notes: [
        [0, 79, 0.5],
        [0.12, 72, 0.9],
      ],
      type: "triangle",
      gain: 0.28,
    },
  ],
  // a gentle clock, then a low note
  tick: [
    {
      notes: [
        [0, 96, 0.05],
        [0.25, 96, 0.05],
        [0.5, 96, 0.05],
        [0.75, 67, 1.1],
      ],
      type: "sine",
      gain: 0.22,
    },
  ],
  // up a major arpeggio
  success: [
    {
      notes: [
        [0, 72, 0.35],
        [0.09, 76, 0.35],
        [0.18, 79, 0.4],
        [0.27, 84, 0.8],
      ],
      type: "triangle",
      gain: 0.22,
    },
  ],
  // two low buzzes
  error: [
    {
      notes: [
        [0, 50, 0.22],
        [0.26, 47, 0.5],
      ],
      type: "sawtooth",
      gain: 0.08,
    },
  ],
  // a short brass call
  fanfare: [
    {
      notes: [
        [0, 67, 0.2],
        [0.2, 67, 0.12],
        [0.34, 67, 0.12],
        [0.48, 72, 0.6],
        [1.1, 76, 0.25],
        [1.35, 79, 1],
      ],
      type: "sawtooth",
      gain: 0.07,
    },
    {
      notes: [
        [0.48, 60, 0.6],
        [1.35, 64, 1],
      ],
      type: "triangle",
      gain: 0.15,
    },
  ],
};

/** Plays a built-in on `bus`, starting `from` seconds into it (for a cue someone joins late). */
export function playBuiltin(context: BaseAudioContext, bus: AudioNode, name: Builtin, from = 0) {
  const start = context.currentTime + 0.02;
  for (const voice of BUILTIN_NOTES[name]) {
    for (const [offset, note, length] of voice.notes) {
      // notes already over are skipped; one in progress is cut in from its start, which is close enough
      if (offset + length <= from) continue;
      tone(context, bus, start + Math.max(0, offset - from), note, length, voice.type, voice.gain);
    }
  }
}

// ── generated music ──────────────────────────────────────────────────────

// a lo-fi progression, ii–V–I–vi in C with sevenths, as MIDI notes
const PROGRESSION: Tuple<Tuple<number>> = [
  [50, 53, 57, 60], // Dm7
  [43, 53, 55, 59], // G7
  [48, 52, 55, 59], // Cmaj7
  [45, 52, 55, 60], // Am7
];

/** Music generated beat by beat until stopped. */
export class Generator {
  private timer: number | null = null;
  private nextBeat = 0;
  private beat = 0;
  private noise: AudioBuffer | null = null;

  constructor(
    private context: AudioContext,
    private bus: AudioNode,
    private style: MusicStyle,
    private tempo: number,
  ) {}

  start() {
    this.nextBeat = this.context.currentTime + 0.1;
    this.beat = 0;
    // a lookahead scheduler: timers are imprecise, so notes are queued a little ahead on the
    // audio clock, which is exact
    this.timer = window.setInterval(() => this.schedule(), 40);
    this.schedule();
  }

  stop() {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  private schedule() {
    const secondsPerBeat = 60 / this.tempo;
    while (this.nextBeat < this.context.currentTime + 0.25) {
      if (this.style === "lofi") this.lofiBeat(this.nextBeat, this.beat, secondsPerBeat);
      else this.ambientBeat(this.nextBeat, this.beat, secondsPerBeat);
      this.nextBeat += secondsPerBeat;
      this.beat++;
    }
  }

  private pad(at: number, notes: Tuple<number>, length: number, gain: number, cutoff: number) {
    const filter = this.context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = cutoff;
    filter.Q.value = 0.7;
    const envelope = this.context.createGain();
    envelope.gain.setValueAtTime(0, at);
    envelope.gain.linearRampToValueAtTime(gain, at + Math.min(0.6, length / 3));
    envelope.gain.setValueAtTime(gain, at + length * 0.75);
    envelope.gain.linearRampToValueAtTime(0, at + length);
    filter.connect(envelope).connect(this.bus);
    for (const note of notes) {
      // two detuned saws per note make the warm, slightly wobbly pad
      for (const detune of [-7, 7]) {
        const oscillator = this.context.createOscillator();
        oscillator.type = "sawtooth";
        oscillator.frequency.value = hz(note);
        oscillator.detune.value = detune;
        oscillator.connect(filter);
        oscillator.start(at);
        oscillator.stop(at + length + 0.05);
      }
    }
  }

  private kick(at: number) {
    const oscillator = this.context.createOscillator();
    const envelope = this.context.createGain();
    oscillator.frequency.setValueAtTime(110, at);
    oscillator.frequency.exponentialRampToValueAtTime(45, at + 0.12);
    envelope.gain.setValueAtTime(0.5, at);
    envelope.gain.exponentialRampToValueAtTime(0.001, at + 0.3);
    oscillator.connect(envelope).connect(this.bus);
    oscillator.start(at);
    oscillator.stop(at + 0.35);
  }

  private hiss(at: number, length: number, gain: number, highpass: number) {
    const context = this.context;
    if (!this.noise) {
      this.noise = context.createBuffer(1, context.sampleRate, context.sampleRate);
      const data = this.noise.getChannelData(0);
      const next = random(7);
      for (let i = 0; i < data.length; i++) data[i] = next() * 2 - 1;
    }
    const source = context.createBufferSource();
    source.buffer = this.noise;
    const filter = context.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = highpass;
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(gain, at);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + length);
    source.connect(filter).connect(envelope).connect(this.bus);
    source.start(at, (at * 0.37) % 0.9);
    source.stop(at + length + 0.02);
  }

  /** Four beats a bar: a chord each bar, a lazy arpeggio, kick, snare and hats. */
  private lofiBeat(at: number, beat: number, secondsPerBeat: number) {
    const bar = Math.floor(beat / 4);
    const step = beat % 4;
    const chord = PROGRESSION[bar % PROGRESSION.length] ?? PROGRESSION[0] ?? [];
    if (step === 0) this.pad(at, chord, secondsPerBeat * 4, 0.05, 900);
    if (step === 0 || (step === 2 && bar % 2 === 1)) this.kick(at);
    if (step === 1 || step === 3) this.hiss(at, 0.18, 0.12, 1800); // snare
    // swung eighth-note hats
    this.hiss(at, 0.04, 0.05, 7000);
    this.hiss(at + secondsPerBeat * 0.62, 0.03, 0.03, 7000);
    // two arpeggio notes a beat, from the chord, an octave or two up
    const next = random(bar * 31 + step * 7 + 1);
    for (const offset of [0, 0.5]) {
      if (next() < 0.35) continue;
      const note = (chord[Math.floor(next() * chord.length)] ?? 60) + (next() < 0.5 ? 12 : 24);
      tone(
        this.context,
        this.bus,
        at + offset * secondsPerBeat,
        note,
        secondsPerBeat * 0.9,
        "triangle",
        0.05,
      );
    }
  }

  /** Slow pads two bars long, with a sparse bell melody and no drums. */
  private ambientBeat(at: number, beat: number, secondsPerBeat: number) {
    const bar = Math.floor(beat / 8);
    const step = beat % 8;
    const chord = PROGRESSION[bar % PROGRESSION.length] ?? PROGRESSION[0] ?? [];
    if (step === 0) {
      this.pad(
        at,
        chord.map((note) => note + 12),
        secondsPerBeat * 8.5,
        0.035,
        1400,
      );
    }
    const next = random(bar * 17 + step * 3 + 5);
    if (next() < 0.4) {
      // a pentatonic note above the chord, like a distant bell
      const scale = [0, 2, 4, 7, 9];
      const note = 72 + (scale[Math.floor(next() * scale.length)] ?? 0);
      tone(this.context, this.bus, at, note, secondsPerBeat * 3, "sine", 0.06);
    }
  }
}
