// asynthcii — ascii synth with a dirty lo-fi sawtooth

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

// computer keyboard → semitone from the current octave's C
const KEYMAP = 'awsedftgyhujkolp;'

const OSCS = [
  { label: 'FAT x3', oscillator: { type: 'fatsawtooth', count: 3 } },
  { label: 'RAW', oscillator: { type: 'sawtooth' } },
  { label: 'FAT x7', oscillator: { type: 'fatsawtooth', count: 7 } },
  { label: 'SAW4', oscillator: { type: 'sawtooth4' } }
]

const hz = (v) => (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v) + 'hz')
const sec = (v) => (v >= 1 ? v.toFixed(1) + 's' : Math.round(v * 1000) + 'ms')
const pct = (v) => Math.round(v * 100) + '%'

// `value` is the default; each synth keeps its own copy of the values
const PARAMS = [
  { key: 'detune', name: 'DETUNE', min: 0, max: 60, value: 24, fmt: (v) => Math.round(v) + 'ct' },
  { key: 'drive', name: 'DRIVE', min: 0, max: 1, value: 0.65, fmt: pct },
  { key: 'crush', name: 'BITS', min: 2, max: 16, value: 7, step: 1, fmt: (v) => v + 'bit' },
  { key: 'cutoff', name: 'CUTOFF', min: 60, max: 8000, value: 420, exp: true, fmt: hz },
  { key: 'res', name: 'RESO', min: 0.5, max: 16, value: 7, fmt: (v) => v.toFixed(1) + 'q' },
  { key: 'env', name: 'ENV', min: 0, max: 6, value: 3.5, fmt: (v) => v.toFixed(1) + 'oct' },
  { key: 'attack', name: 'ATTACK', min: 0.001, max: 2, value: 0.004, exp: true, fmt: sec },
  { key: 'release', name: 'RELEASE', min: 0.02, max: 4, value: 0.4, exp: true, fmt: sec },
  { key: 'tape', name: 'TAPE', min: 800, max: 16000, value: 3800, exp: true, fmt: hz },
  { key: 'wow', name: 'WOW', min: 0, max: 1, value: 0.25, fmt: pct },
  { key: 'hiss', name: 'HISS', min: 0, max: 1, value: 0.3, fmt: pct },
  { key: 'room', name: 'ROOM', min: 0, max: 1, value: 0.18, fmt: pct },
  { key: 'volume', name: 'VOLUME', min: -36, max: 0, value: -8, fmt: (v) => Math.round(v) + 'db' }
]
// volume is a fader in the osc bar, everything else is a knob
const KNOBS = PARAMS.filter((p) => p.key !== 'volume')

// every synth has its own sound, octave and pattern; the transport is shared
const synths = []
// the synth scrolled into view, it gets the computer keyboard
let active = 0

// master bus + the sequencer loop, built on the first user gesture
let audio = null
const ui = {}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v))

function noteName(midi) {
  return NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1)
}

function baseMidi(s) {
  return (s.octave + 1) * 12
}

function createSynth(notes = []) {
  return {
    values: Object.fromEntries(PARAMS.map((p) => [p.key, p.value])),
    osc: 0,
    octave: 2,
    held: new Map(),
    notes,
    hover: null,
    drag: null,
    audio: null,
    ui: {}
  }
}

// ---------- audio

function makeSynth(s) {
  const p = s.values
  const synth = new Tone.PolySynth(Tone.MonoSynth, {
    maxPolyphony: 12,
    oscillator: { ...OSCS[s.osc].oscillator, spread: p.detune },
    envelope: { attack: p.attack, decay: 0.2, sustain: 0.6, release: p.release },
    filter: { type: 'lowpass', rolloff: -24, Q: p.res },
    filterEnvelope: {
      attack: 0.003,
      decay: 0.25,
      sustain: 0.3,
      release: 0.4,
      baseFrequency: p.cutoff,
      octaves: p.env
    }
  })
  synth.volume.value = -6
  return synth
}

function buildMaster() {
  // several synths summed can clip, the limiter keeps the sum in range
  const master = new Tone.Limiter(-1)
  const meter = new Tone.Meter({ normalRange: true, smoothing: 0.85 })
  master.connect(meter)
  master.toDestination()
  const loop = new Tone.Loop(rollTick, '16n').start(0)
  return { master, meter, loop }
}

function buildSynthAudio(s) {
  const p = s.values
  const synth = makeSynth(s)

  // dirt
  const dist = new Tone.Distortion({ distortion: p.drive, oversample: '2x' })
  // bit reduction as a staircase waveshaper: Tone.BitCrusher needs an AudioWorklet,
  // which browsers refuse to load when the page is opened from file://
  const crush = new Tone.WaveShaper(crushCurve(p.crush))

  // lo-fi tape: wobble, band-limit, small room
  const wow = new Tone.Vibrato({ frequency: 0.7, depth: p.wow * 0.35 })
  const tapeLow = new Tone.Filter({ type: 'lowpass', frequency: p.tape, rolloff: -24 })
  const tapeHigh = new Tone.Filter({ type: 'highpass', frequency: 70 })
  const comp = new Tone.Compressor({ threshold: -20, ratio: 4 })
  const room = new Tone.Reverb({ decay: 1.8, preDelay: 0.01, wet: p.room })
  const vol = new Tone.Volume(p.volume)

  const scope = new Tone.Waveform(512)

  synth.chain(dist, crush, wow, tapeLow, tapeHigh, comp, room, vol)
  vol.fan(scope, audio.master)

  // hiss has its own path so the background meter stays white in silence
  const noise = new Tone.Noise('pink')
  const hiss = new Tone.Volume(hissDb(p.hiss))
  const hissVol = new Tone.Volume(p.volume)
  noise.chain(hiss, hissVol, Tone.getDestination())
  noise.start()

  const nodes = [dist, crush, wow, tapeLow, tapeHigh, comp, room, vol, scope, noise, hiss, hissVol]
  return { synth, dist, crush, wow, tapeLow, room, vol, hiss, hissVol, noise, scope, nodes }
}

// lets the release tails ring out before tearing the chain down
function disposeSynthAudio(s) {
  const a = s.audio
  if (!a) return
  s.audio = null
  a.synth.releaseAll()
  a.noise.stop()
  setTimeout(() => [a.synth, ...a.nodes].forEach((n) => n.dispose()), (s.values.release + 1) * 1000)
}

function crushCurve(bits) {
  const steps = Math.pow(2, bits - 1)
  const size = 8192
  return Float32Array.from({ length: size }, (_, i) => {
    const x = (i / (size - 1)) * 2 - 1
    return Math.round(x * steps) / steps
  })
}

function hissDb(v) {
  return v <= 0 ? -Infinity : -52 + v * 30
}

function applyParam(s, key, v) {
  const a = s.audio
  if (!a) return
  const { synth } = a
  switch (key) {
    case 'drive':
      a.dist.distortion = v
      break
    case 'crush':
      a.crush.curve = crushCurve(v)
      break
    case 'cutoff':
      synth.set({ filterEnvelope: { baseFrequency: v } })
      break
    case 'res':
      synth.set({ filter: { Q: v } })
      break
    case 'env':
      synth.set({ filterEnvelope: { octaves: v } })
      break
    case 'detune':
      synth.set({ oscillator: { spread: v } })
      break
    case 'attack':
      synth.set({ envelope: { attack: v } })
      break
    case 'release':
      synth.set({ envelope: { release: v } })
      break
    case 'tape':
      a.tapeLow.frequency.rampTo(v, 0.05)
      break
    case 'wow':
      a.wow.depth.value = v * 0.35
      break
    case 'hiss':
      a.hiss.volume.value = hissDb(v)
      break
    case 'room':
      a.room.wet.value = v
      break
    case 'volume':
      a.vol.volume.rampTo(v, 0.05)
      a.hissVol.volume.rampTo(v, 0.05)
      break
  }
}

async function ensureAudio() {
  if (audio) return
  await Tone.start()
  if (audio) return
  audio = buildMaster()
  synths.forEach((s) => (s.audio = buildSynthAudio(s)))
}

// a note can be held by several sources at once
async function noteOn(s, midi, source) {
  const holders = s.held.get(midi) || new Set()
  const fresh = holders.size === 0
  holders.add(source)
  s.held.set(midi, holders)
  await ensureAudio()
  if (fresh && s.held.get(midi)?.has(source)) {
    s.audio?.synth.triggerAttack(noteName(midi), Tone.now(), 0.8)
  }
}

function noteOff(s, midi, source) {
  const holders = s.held.get(midi)
  if (!holders || !holders.delete(source)) return
  if (holders.size === 0) {
    s.held.delete(midi)
    s.audio?.synth.triggerRelease(noteName(midi), Tone.now())
  }
}

function releaseAll(s) {
  s.held.clear()
  s.audio?.synth.releaseAll()
}

// ---------- ascii layout helpers

function part(node, w) {
  return { node, w }
}

function txt(s, cls) {
  if (!cls) return part(document.createTextNode(s), s.length)
  const span = document.createElement('span')
  span.className = cls
  span.textContent = s
  return part(span, s.length)
}

// box-drawing characters are painted in the accent color
function ink(s) {
  return txt(s, 'Ink')
}

function btn(label, onClick) {
  const span = document.createElement('span')
  span.className = 'Btn'
  span.textContent = label
  span.addEventListener('click', onClick)
  return part(span, label.length)
}

// fixed-width text slot that can be updated later
function slot(w, align = 'left', cls = '') {
  const span = document.createElement('span')
  if (cls) span.className = cls
  span.set = (s) => {
    if (align === 'center') s = ' '.repeat(Math.max(0, Math.floor((w - s.length) / 2))) + s
    span.textContent = align === 'right' ? s.padStart(w).slice(-w) : s.padEnd(w).slice(0, w)
  }
  span.set('')
  return part(span, w)
}

function norm(parts) {
  return parts.map((p) => (typeof p === 'string' ? txt(p) : p))
}

function line(parts) {
  const div = document.createElement('div')
  div.className = 'Line'
  for (const p of norm(parts)) div.appendChild(p.node)
  return div
}

function cell(parts, w, align = 'left') {
  parts = norm(parts)
  const used = parts.reduce((s, p) => s + p.w, 0)
  const free = Math.max(0, w - used)
  if (align === 'center') {
    const l = Math.floor(free / 2)
    return [txt(' '.repeat(l)), ...parts, txt(' '.repeat(free - l))]
  }
  return [...parts, txt(' '.repeat(free))]
}

// left parts flush left, right parts flush right
function spread(left, right) {
  left = norm(left)
  right = norm(right)
  const used = [...left, ...right].reduce((s, p) => s + p.w, 0)
  return [...left, txt(' '.repeat(Math.max(0, INNER - used))), ...right]
}

function row(parts, align) {
  return line([ink('|'), ...cell(parts, INNER, align), ink('|')])
}

function border() {
  return line([ink('+' + '-'.repeat(INNER) + '+')])
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }

function esc(s) {
  return s.replace(/[&<>]/g, (c) => ESC[c])
}

// ---------- ui

const INNER = 62

function buildUI() {
  const app = document.getElementById('app')
  const add = (el) => app.appendChild(el)

  // title + rack navigation
  ui.rackPos = slot(5, 'center', 'Bold')
  add(border())
  add(
    row(
      spread(
        [' ', txt('ASYNTHCII', 'Bold Accent'), txt(' :: DIRTY LO-FI SAW SYNTH', 'Muted')],
        [
          btn('(<)', () => goTo(active - 1)),
          ' ',
          ui.rackPos,
          ' ',
          btn('(>)', () => goTo(active + 1)),
          ' ',
          btn('(+ADD)', () => addSynth()),
          ' '
        ]
      )
    )
  )

  // transport, shared by every synth
  ui.play = btn('(>)  PLAY ', togglePlay)
  ui.bpm = slot(3, 'center', 'Bold')
  ui.rollInfo = slot(17, 'right')
  add(border())
  add(
    row(
      spread(
        [
          ' ',
          ui.play,
          ' ',
          btn('(|<)', rewind),
          '   BPM ',
          btn('(-)', (e) => setBpm(roll.bpm - (e.shiftKey ? 10 : 1))),
          ' [',
          ui.bpm,
          '] ',
          btn('(+)', (e) => setBpm(roll.bpm + (e.shiftKey ? 10 : 1)))
        ],
        [ui.rollInfo, ' ']
      )
    )
  )
  add(border())

  // synths sit side by side and scroll horizontally, one screen each
  ui.rack = document.createElement('div')
  ui.rack.className = 'Rack'
  ui.rack.addEventListener('scroll', updateActive, { passive: true })
  add(ui.rack)
}

function buildSynthUI(s) {
  const el = document.createElement('section')
  el.className = 'Synth'
  const add = (x) => el.appendChild(x)
  const u = s.ui
  u.el = el

  // name + octave
  u.name = slot(8, 'left', 'Bold Accent')
  u.octave = slot(3, 'center', 'Bold')
  add(
    row(
      spread(
        [' ', u.name, '  ', btn('(CLR)', () => clearRoll(s)), ' ', btn('(DEL)', () => deleteSynth(s))],
        ['OCT ', btn('(-)', () => shiftOctave(s, -1)), ' [', u.octave, '] ', btn('(+)', () => shiftOctave(s, 1)), ' ']
      )
    )
  )

  // oscillator selector + volume fader
  u.oscs = OSCS.map((o, i) => btn(`(${o.label})`, () => setOsc(s, i)))
  const oscParts = [' ', txt('OSC', 'Bold'), ' : ']
  u.oscs.forEach((b) => oscParts.push(b, ' '))
  u.volumeBar = part(document.createElement('span'), 10)
  u.volume = slot(5, 'right')
  oscParts.push(' '.repeat(3), txt('VOL', 'Bold'), ' ', u.volumeBar, ' ', u.volume)
  add(border())
  add(row(oscParts))
  fader(s, PARAMS.find((p) => p.key === 'volume'))

  // knobs: 2 rows of 6
  add(border())
  for (let i = 0; i < KNOBS.length; i += 6) {
    const group = KNOBS.slice(i, i + 6).map((p) => knob(s, p))
    add(row([]))
    for (let r = 0; r < KNOB_H + 2; r++) {
      const parts = [' ']
      group.forEach((k) => parts.push(k.lines[r], ' '))
      add(row(parts))
    }
  }
  add(row([]))

  // scope
  u.scope = Array.from({ length: SCOPE_H }, () => slot(SCOPE_W, 'left', 'Accent'))
  add(border())
  u.scope.forEach((x) => add(row([' ', x])))
  add(border())

  // piano roll: note names hang in the left gutter, the grid keeps 64 columns
  const wrap = document.createElement('div')
  wrap.className = 'RollWrap'
  u.rollLabels = document.createElement('pre')
  u.rollLabels.className = 'RollLabels'
  u.roll = document.createElement('pre')
  u.roll.className = 'Roll'
  wrap.append(u.rollLabels, u.roll)
  add(wrap)
  bindRoll(s)
  return el
}

// ---------- knob
//
//   *****      ring of 13 dots, lit up to the value
//  *     .
//  *  o- .     pointer from the center shows the angle
//  *     .
//   *   .

const KNOB_W = 9
const KNOB_H = 5
// prettier-ignore
const RING = [
  [2, 4], [1, 3], [1, 2], [1, 1], [2, 0], [3, 0], [4, 0],
  [5, 0], [6, 0], [7, 1], [7, 2], [7, 3], [6, 4]
]

function toNorm(p, v) {
  return p.exp ? Math.log(v / p.min) / Math.log(p.max / p.min) : (v - p.min) / (p.max - p.min)
}

function fromNorm(p, n) {
  n = clamp(n, 0, 1)
  let v = p.exp ? p.min * Math.pow(p.max / p.min, n) : p.min + n * (p.max - p.min)
  if (p.step) v = Math.round(v / p.step) * p.step
  return clamp(v, p.min, p.max)
}

function pointerChar(deg) {
  const a = Math.abs(deg)
  if (a < 22.5) return '|'
  if (a > 112.5) return deg > 0 ? '\\' : '/'
  if (a > 67.5) return '-'
  return deg > 0 ? '/' : '\\'
}

function knob(s, p) {
  const rows = Array.from({ length: KNOB_H }, () => {
    const span = document.createElement('span')
    span.className = 'Knob'
    return span
  })
  const label = slot(KNOB_W, 'center', 'Bold Knob')
  const value = slot(KNOB_W, 'center', 'Muted')
  label.node.set(p.name)
  const get = () => s.values[p.key]

  const paint = () => {
    const n = clamp(toNorm(p, get()), 0, 1)
    const grid = Array.from({ length: KNOB_H }, () => Array(KNOB_W).fill(null))
    const lit = Math.round(n * (RING.length - 1))
    RING.forEach(([x, y], i) => (grid[y][x] = i <= lit ? ['*', 'Accent Bold'] : ['.', 'Muted']))

    const deg = -135 + n * 270
    const rad = (deg * Math.PI) / 180
    const ch = pointerChar(deg)
    grid[2 + Math.round(-Math.cos(rad))][4 + Math.round(Math.sin(rad) * 2)] = [ch, 'Bold']
    if (Math.abs(Math.sin(rad)) > 0.9) grid[2][4 + Math.sign(Math.sin(rad))] = [ch, 'Bold']
    grid[2][4] = ['o', 'Bold']

    rows.forEach((span, y) => {
      span.innerHTML = grid[y].map((c) => (c ? `<span class="${c[1]}">${esc(c[0])}</span>` : ' ')).join('')
    })
    value.node.set(p.fmt(get()))
  }

  const set = (v) => {
    s.values[p.key] = v
    applyParam(s, p.key, v)
    paint()
  }

  let drag = null
  for (const span of [...rows, label.node]) {
    span.addEventListener('pointerdown', (e) => {
      span.setPointerCapture(e.pointerId)
      drag = { y: e.clientY, n: toNorm(p, get()) }
    })
    span.addEventListener('pointermove', (e) => {
      if (drag && span.hasPointerCapture(e.pointerId)) set(fromNorm(p, drag.n + (drag.y - e.clientY) / 160))
    })
    span.addEventListener('pointerup', () => (drag = null))
    span.addEventListener('dblclick', () => set(p.value))
    span.addEventListener(
      'wheel',
      (e) => {
        // horizontal swipes scroll the rack
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return
        e.preventDefault()
        set(fromNorm(p, toNorm(p, get()) + (e.deltaY < 0 ? 1 : -1) / 40))
      },
      { passive: false }
    )
  }

  paint()
  return { lines: [...rows.map((x) => part(x, KNOB_W)), label, value] }
}

// horizontal ascii fader: [######..]
function fader(s, p) {
  const bar = s.ui.volumeBar.node
  bar.className = 'Fader'
  const paint = () => {
    const n = Math.round(clamp(toNorm(p, s.values[p.key]), 0, 1) * 8)
    bar.innerHTML = `<span class="Ink">[</span><span class="Accent">${'#'.repeat(n)}</span><span class="Muted">${'.'.repeat(8 - n)}</span><span class="Ink">]</span>`
    s.ui.volume.node.set(p.fmt(s.values[p.key]))
  }
  const set = (v) => {
    s.values[p.key] = v
    applyParam(s, p.key, v)
    paint()
  }
  const fromEvent = (e) => {
    const r = bar.getBoundingClientRect()
    const ch = r.width / 10
    set(fromNorm(p, (e.clientX - r.left - ch) / (ch * 8)))
  }
  bar.addEventListener('pointerdown', (e) => {
    bar.setPointerCapture(e.pointerId)
    fromEvent(e)
  })
  bar.addEventListener('pointermove', (e) => {
    if (bar.hasPointerCapture(e.pointerId)) fromEvent(e)
  })
  bar.addEventListener('dblclick', () => set(p.value))
  paint()
}

// ---------- controls

function setOsc(s, i) {
  s.osc = i
  const a = s.audio
  if (a) {
    // changing the wave type of a sounding OmniOscillator drops its scheduled stop,
    // so PolySynth never gets the voice back. swap in a fresh synth instead.
    const old = a.synth
    a.synth = makeSynth(s)
    a.synth.connect(a.dist)
    old.releaseAll()
    setTimeout(() => old.dispose(), (s.values.release + 1) * 1000)
  }
  renderSynth(s)
}

function shiftOctave(s, d) {
  releaseAll(s)
  s.octave = clamp(s.octave + d, 0, 7)
  renderSynth(s)
  renderTransport()
}

function renderSynth(s) {
  s.ui.name.node.set('SYNTH ' + (synths.indexOf(s) + 1))
  s.ui.octave.node.set('C' + s.octave)
  s.ui.oscs.forEach((b, i) => b.node.classList.toggle('is-on', i === s.osc))
  renderRoll(s)
}

function renderAll() {
  ui.rackPos.node.set(`${active + 1}/${synths.length}`)
  synths.forEach(renderSynth)
  renderTransport()
}

// ---------- rack

function addSynth(notes = []) {
  const s = createSynth(notes)
  synths.push(s)
  ui.rack.appendChild(buildSynthUI(s))
  if (audio) s.audio = buildSynthAudio(s)
  renderAll()
  goTo(synths.length - 1)
}

function deleteSynth(s) {
  if (synths.length === 1) return
  releaseAll(s)
  disposeSynthAudio(s)
  synths.splice(synths.indexOf(s), 1)
  s.ui.el.remove()
  active = Math.min(active, synths.length - 1)
  updateActive()
  renderAll()
}

// scroll offset of a synth when it's snapped into view
function rackOffset(i) {
  return synths[i].ui.el.offsetLeft - synths[0].ui.el.offsetLeft
}

function goTo(i) {
  i = clamp(i, 0, synths.length - 1)
  ui.rack.scrollTo({ left: rackOffset(i), behavior: 'smooth' })
}

function updateActive() {
  const x = ui.rack.scrollLeft
  let best = 0
  synths.forEach((_, i) => {
    if (Math.abs(rackOffset(i) - x) < Math.abs(rackOffset(best) - x)) best = i
  })
  active = best
  ui.rackPos.node.set(`${active + 1}/${synths.length}`)
}

// ---------- piano roll
//
// 64 sixteenth steps x 24 semitones from the synth's octave C.
// notes are stored relative to that C, so OCT transposes the pattern.

const STEPS = 64
const ROWS = 24
const BLACK_KEYS = [1, 3, 6, 8, 10]
// cmd/ctrl + drag repeats a one-step note every REPEAT steps
const REPEAT = 8

const roll = {
  playing: false,
  bpm: 120,
  step: 0,
  playCol: -1
}

function defaultPattern() {
  // c minor, one bar per line: Cm | Cm | Ab | Bb. [start, semitone, length]
  // prettier-ignore
  const bass = [
    [[0, 0, 3], [4, 0, 1], [6, 0, 1], [8, 7, 2], [10, 0, 2], [12, 3, 2], [14, 5, 2]],
    [[0, 0, 3], [4, 0, 1], [6, 0, 1], [8, 7, 2], [10, 0, 2], [12, 3, 2], [14, 5, 2]],
    [[0, 8, 3], [4, 8, 1], [6, 8, 1], [8, 3, 2], [10, 8, 2], [12, 7, 2], [14, 5, 2]],
    [[0, 10, 3], [4, 10, 1], [6, 10, 1], [8, 5, 2], [10, 10, 2], [12, 7, 2], [14, 2, 2]]
  ]
  // the melody sits an octave above the bass
  // prettier-ignore
  const melody = [
    [[0, 19, 4], [4, 20, 2], [6, 19, 2], [8, 15, 4], [12, 17, 2], [14, 15, 2]],
    [[0, 14, 2], [2, 15, 2], [4, 17, 4], [8, 19, 6], [14, 22, 2]],
    [[0, 20, 4], [4, 19, 2], [6, 17, 2], [8, 15, 4], [12, 12, 4]],
    [[0, 14, 3], [3, 15, 3], [6, 17, 2], [8, 22, 4], [12, 19, 4]]
  ]
  return [...bass, ...melody].flatMap((bar, i) =>
    bar.map(([start, semi, len]) => ({ start: start + (i % 4) * 16, semi, len }))
  )
}

const rowSemi = (r) => ROWS - 1 - r

function noteAt(s, semi, col) {
  return s.notes.findIndex((n) => n.semi === semi && col >= n.start && col < n.start + n.len)
}

function rollTick(time) {
  const col = roll.step
  const step = Tone.Time('16n').toSeconds()
  for (const s of synths) {
    if (!s.audio) continue
    for (const n of s.notes) {
      if (n.start === col) {
        s.audio.synth.triggerAttackRelease(noteName(baseMidi(s) + n.semi), n.len * step * 0.95, time, 0.8)
      }
    }
  }
  Tone.getDraw().schedule(() => {
    roll.playCol = col
    synths.forEach(renderRoll)
    renderTransport()
  }, time)
  roll.step = (col + 1) % STEPS
}

async function togglePlay() {
  await ensureAudio()
  const transport = Tone.getTransport()
  if (roll.playing) {
    transport.pause()
    roll.playing = false
  } else {
    transport.bpm.value = roll.bpm
    transport.start('+0.05')
    roll.playing = true
  }
  renderTransport()
}

function rewind() {
  roll.step = 0
  if (!roll.playing) roll.playCol = -1
  synths.forEach(renderRoll)
  renderTransport()
}

function setBpm(v) {
  roll.bpm = clamp(v, 30, 300)
  if (audio) Tone.getTransport().bpm.rampTo(roll.bpm, 0.05)
  renderTransport()
}

function clearRoll(s) {
  s.notes = []
  renderRoll(s)
}

function renderTransport() {
  ui.play.node.textContent = roll.playing ? '(||) PAUSE' : '(>)  PLAY '
  ui.play.node.classList.toggle('is-on', roll.playing)
  ui.bpm.node.set(String(roll.bpm))
  const pos = String(Math.max(roll.playCol, 0) + 1).padStart(2, '0') + '/' + STEPS
  const s = synths.find((x) => x.hover)
  const h = s?.hover
  ui.rollInfo.node.set(h ? `${noteName(baseMidi(s) + rowSemi(h.r))} @ ${h.c + 1}   ${pos}` : `STEP ${pos}`)
}

function renderRoll(s) {
  const u = s.ui
  const owner = Array.from({ length: ROWS }, () => new Int16Array(STEPS).fill(-1))
  s.notes.forEach((n, k) => {
    const r = ROWS - 1 - n.semi
    if (r < 0 || r >= ROWS) return
    for (let c = n.start; c < Math.min(STEPS, n.start + n.len); c++) owner[r][c] = k
  })

  const lines = []
  for (let r = 0; r < ROWS; r++) {
    const semi = rowSemi(r)
    const isC = semi % 12 === 0
    let html = ''
    let run = ''
    let runCls = null
    const flush = () => {
      if (run) html += runCls ? `<span class="${runCls}">${run}</span>` : run
      run = ''
    }
    for (let c = 0; c < STEPS; c++) {
      let ch = isC && c % 8 === 0 ? '+' : '.'
      let cls = BLACK_KEYS.includes(semi % 12) ? 'k' : ''
      if (c === roll.playCol) cls = 'p'
      const k = owner[r][c]
      if (k >= 0) {
        if (s.notes[k].start === c) ch = '*'
        cls = c === roll.playCol ? 'h' : 'm'
      }
      if (s.hover && s.hover.r === r && s.hover.c === c) cls = 'c'
      if (cls !== runCls) {
        flush()
        runCls = cls
      }
      run += ch
    }
    flush()
    lines.push(html)
  }
  u.roll.innerHTML = lines.join('\n')
  u.rollLabels.innerHTML = Array.from({ length: ROWS }, (_, r) => {
    const name = noteName(baseMidi(s) + rowSemi(r))
    return rowSemi(r) % 12 === 0 ? `<span class="Bold">${name}</span>` : name
  }).join('\n')
}

function bindRoll(s) {
  const el = s.ui.roll
  const cellAt = (e) => {
    const rect = el.getBoundingClientRect()
    return {
      r: clamp(Math.floor(((e.clientY - rect.top) / rect.height) * ROWS), 0, ROWS - 1),
      c: clamp(Math.floor(((e.clientX - rect.left) / rect.width) * STEPS), 0, STEPS - 1)
    }
  }

  const repeating = (e) => e.metaKey || e.ctrlKey

  // replaces the notes from the current repeat drag with ones at every REPEAT steps up to col
  const fillRepeat = (d, col) => {
    s.notes = s.notes.filter((n) => !d.notes.includes(n))
    const count = col > d.start ? Math.floor((col - d.start) / REPEAT) + 1 : 1
    d.notes = []
    for (let i = 0; i < count; i++) {
      const start = d.start + i * REPEAT
      if (noteAt(s, d.semi, start) < 0) d.notes.push({ start, semi: d.semi, len: 1 })
    }
    s.notes.push(...d.notes)
  }

  // ctrl+click opens the context menu on macOS
  el.addEventListener('contextmenu', (e) => e.preventDefault())
  el.addEventListener('pointerdown', async (e) => {
    el.setPointerCapture(e.pointerId)
    const { r, c } = cellAt(e)
    const semi = rowSemi(r)
    const k = noteAt(s, semi, c)
    if (k >= 0) {
      s.notes.splice(k, 1)
      s.drag = null
    } else {
      const note = { start: c, semi, len: 1 }
      s.notes.push(note)
      if (repeating(e)) {
        s.drag = { repeat: true, start: c, semi, notes: [note] }
      } else {
        // a note can grow until the next note on the same row
        const next = s.notes.filter((n) => n.semi === semi && n.start > c).map((n) => n.start)
        s.drag = { note, limit: Math.min(STEPS, ...next) }
      }
      await ensureAudio()
      s.audio?.synth.triggerAttackRelease(noteName(baseMidi(s) + semi), '16n', Tone.now(), 0.7)
    }
    renderRoll(s)
  })
  el.addEventListener('pointermove', (e) => {
    const { r, c } = cellAt(e)
    s.hover = { r, c }
    const d = s.drag
    if (d && el.hasPointerCapture(e.pointerId)) {
      if (d.repeat) fillRepeat(d, c)
      else d.note.len = clamp(c - d.note.start + 1, 1, d.limit - d.note.start)
    }
    renderRoll(s)
    renderTransport()
  })
  el.addEventListener('pointerup', () => (s.drag = null))
  el.addEventListener('pointerleave', () => {
    s.hover = null
    renderRoll(s)
    renderTransport()
  })
}

// ---------- scope + background

const SCOPE_W = 60
const SCOPE_H = 3
const SCOPE_CHARS = ['_', '-', '`'] // bottom, middle, top of a character cell

function renderScope(s) {
  const lines = Array.from({ length: SCOPE_H }, () => Array(SCOPE_W).fill(' '))
  const data = s.audio?.scope.getValue()
  const levels = SCOPE_H * SCOPE_CHARS.length

  for (let x = 0; x < SCOPE_W; x++) {
    const v = data ? data[Math.floor((x / SCOPE_W) * data.length)] || 0 : 0
    const l = clamp(Math.floor(((v + 1) / 2) * levels), 0, levels - 1)
    lines[SCOPE_H - 1 - Math.floor(l / SCOPE_CHARS.length)][x] = SCOPE_CHARS[l % SCOPE_CHARS.length]
  }
  s.ui.scope.forEach((x, i) => x.node.set(lines[i].join('')))
}

function renderFrame() {
  synths.forEach(renderScope)
  renderBackground()
  requestAnimationFrame(renderFrame)
}

// background is a level meter: white at silence, 50% accent at full scale
let bgLevel = 0

function renderBackground() {
  const level = audio ? clamp(audio.meter.getValue(), 0, 1) : 0
  bgLevel += (level - bgLevel) * 0.25
  const a = Math.sqrt(bgLevel) * 0.5
  const mix = (c) => Math.round(255 + (c - 255) * a)
  document.documentElement.style.setProperty('--live', `rgb(${mix(255)}, ${mix(71)}, ${mix(212)})`)
}

// ---------- keyboard

function onKey(e, down) {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const key = e.key.toLowerCase()
  const s = synths[active]

  if (key === ' ') {
    e.preventDefault()
    if (down && !e.repeat) togglePlay()
    return
  }

  if (down && !e.repeat && (key === 'z' || key === 'x')) {
    shiftOctave(s, key === 'z' ? -1 : 1)
    return
  }
  const semi = KEYMAP.indexOf(key)
  if (semi < 0) return
  e.preventDefault()
  if (e.repeat) return

  const source = 'key:' + key
  if (down) {
    noteOn(s, baseMidi(s) + semi, source)
  } else {
    // the octave or the active synth may have changed while the key was held
    for (const x of synths) {
      for (const [midi, holders] of x.held) if (holders.has(source)) noteOff(x, midi, source)
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  buildUI()
  addSynth(defaultPattern())
  renderFrame()
  document.addEventListener('keydown', (e) => onKey(e, true))
  document.addEventListener('keyup', (e) => onKey(e, false))
  window.addEventListener('blur', () => synths.forEach(releaseAll))
})
