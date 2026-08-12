import { Link } from "react-router-dom";
import {
  ShieldCheck, Video, ScanSearch, Link2, Radio, ArrowRight, Camera, FileCheck2, Blocks, QrCode,
  Fingerprint, Hash, BadgeCheck, ChevronRight,
} from "lucide-react";

const STEPS = [
  { n: "01", title: "Capture", desc: "Real camera footage is recorded through the browser's actual webcam APIs.", icon: Video },
  { n: "02", title: "Protect", desc: "Recordings are segmented, SHA-256 hashed, and remotely preserved -- independent of the recording device.", icon: ShieldCheck },
  { n: "03", title: "Verify", desc: "Blockchain anchoring and hash-chain integrity checks prove whether evidence has changed.", icon: Link2 },
  { n: "04", title: "Respond", desc: "Camera attacks -- obstruction, disconnection -- are detected in real time and recorded as incidents.", icon: Radio },
];

const PIPELINE = [
  { label: "LIVE CAMERA", icon: Radio },
  { label: "RECORDING", icon: Video },
  { label: "PROTECTED EVIDENCE", icon: ShieldCheck },
  { label: "HASH + CHAIN", icon: Hash },
  { label: "VERIFIED", icon: BadgeCheck },
];

export default function Landing() {
  return (
    <div className="min-h-screen overflow-hidden grid-bg text-slate-100">
      <div className="mx-auto max-w-[1280px] px-5 sm:px-8">
        <header className="flex items-center justify-between py-7">
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-accent-500/10 p-2.5 text-accent-500">
              <Fingerprint size={22} />
            </div>
            <span className="font-bold tracking-[.24em]">CRIMELENS</span>
          </div>
          <Link
            to="/login"
            className="hidden rounded-lg border border-ink-700 px-4 py-2 text-sm text-slate-300 transition hover:border-accent-500/50 hover:text-white sm:block"
          >
            Sign in
          </Link>
        </header>

        {/* Hero */}
        <section className="grid min-h-[620px] items-center gap-14 pb-16 pt-6 lg:grid-cols-[1.05fr_.95fr] lg:pt-10">
          <div className="fade-up">
            <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-accent-500/20 bg-accent-500/5 px-3 py-1.5 text-xs text-accent-500/90">
              <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-accent-500" />
              Blockchain-anchored evidence integrity
            </div>
            <h1 className="max-w-3xl text-5xl font-extrabold leading-[1.04] tracking-[-.055em] text-white sm:text-7xl">
              Turn live footage<br />
              <span className="text-accent-500">into trusted evidence.</span>
            </h1>
            <p className="mt-7 max-w-xl text-base leading-8 text-slate-400 sm:text-lg">
              CrimeLens protects CCTV-style recordings from loss, tampering, and camera attacks --
              creating a verifiable trail from capture to certificate.
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              <Link
                to="/login"
                className="group flex items-center gap-3 rounded-xl bg-accent-500 px-5 py-3.5 font-bold text-ink-950 transition hover:bg-accent-600"
              >
                Get started <ArrowRight size={17} className="transition group-hover:translate-x-1" />
              </Link>
              <a
                href="#how-it-works"
                className="rounded-xl border border-ink-700 px-5 py-3.5 font-semibold text-slate-300 transition hover:border-slate-500 hover:text-white"
              >
                See how it works
              </a>
            </div>
          </div>

          <div className="fade-up relative" style={{ animationDelay: ".12s" }}>
            <div className="absolute -inset-10 rounded-full bg-accent-500/10 blur-3xl" />
            <div className="glass-panel glow relative rounded-3xl p-5 sm:p-7">
              <div className="mb-6 flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[.18em] text-slate-400">
                  <Radio size={14} className="text-accent-500" /> protection pipeline
                </div>
                <span className="mono text-[10px] text-slate-500">LIVE / 01</span>
              </div>
              <div className="space-y-2">
                {PIPELINE.map(({ label, icon: Icon }, i) => (
                  <div key={label} className="relative flex items-center gap-3">
                    <div
                      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${
                        i === PIPELINE.length - 1 ? "bg-emerald-400/10 text-emerald-300" : "bg-accent-500/10 text-accent-500"
                      }`}
                    >
                      <Icon size={18} />
                    </div>
                    <div className="flex flex-1 items-center justify-between rounded-xl bg-ink-900 px-4 py-3">
                      <span className="text-xs font-bold tracking-[.12em] text-slate-200">{label}</span>
                      <span className="mono text-[10px] text-slate-500">0{i + 1} / 05</span>
                    </div>
                    {i < PIPELINE.length - 1 && (
                      <ChevronRight size={13} className="absolute -bottom-3.5 left-[19px] rotate-90 text-slate-600" />
                    )}
                  </div>
                ))}
              </div>
              <div className="mt-6 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg bg-ink-900 px-2 py-3">
                  <div className="mono text-sm text-accent-500">SHA-256</div>
                  <div className="mt-1 text-[10px] text-slate-500">hashing</div>
                </div>
                <div className="rounded-lg bg-ink-900 px-2 py-3">
                  <div className="mono text-sm text-accent-500">CHAINED</div>
                  <div className="mt-1 text-[10px] text-slate-500">integrity</div>
                </div>
                <div className="rounded-lg bg-ink-900 px-2 py-3">
                  <div className="mono text-sm text-warn-500">READY</div>
                  <div className="mt-1 text-[10px] text-slate-500">anchoring</div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* How it works */}
        <section id="how-it-works" className="border-t border-ink-800 py-24">
          <div className="mb-12 max-w-xl">
            <p className="mono text-xs uppercase tracking-[.18em] text-accent-500">One continuous chain of trust</p>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-white sm:text-4xl">
              From camera signal to courtroom confidence.
            </h2>
          </div>
          <div className="grid gap-4 md:grid-cols-4">
            {STEPS.map((s) => (
              <div key={s.n} className="glass-panel rounded-2xl p-5 transition hover:-translate-y-1 hover:border-accent-500/30">
                <div className="flex items-center justify-between">
                  <span className="mono text-sm text-accent-500">{s.n}</span>
                  <s.icon className="text-accent-500" size={18} />
                </div>
                <h3 className="mt-10 font-bold text-white">{s.title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-400">{s.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Why CrimeLens */}
        <section className="border-t border-ink-800 py-20">
          <h2 className="text-2xl font-semibold text-center mb-2 text-white">Why CrimeLens</h2>
          <p className="text-slate-500 text-center text-sm mb-12 max-w-lg mx-auto">
            CrimeLens is an evidence-protection layer, not another CCTV viewer. It sits around
            whatever camera you have and makes the footage it produces defensible.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="glass-panel rounded-2xl p-6">
              <p className="text-xs uppercase tracking-widest text-slate-500 mb-4">Normal CCTV</p>
              <div className="space-y-2 text-sm text-slate-400 mono">
                <div className="border border-ink-700 rounded-lg px-3 py-2">Camera</div>
                <div className="text-center text-slate-600">↓</div>
                <div className="border border-ink-700 rounded-lg px-3 py-2">DVR</div>
                <div className="text-center text-slate-600">↓</div>
                <div className="border border-ink-700 rounded-lg px-3 py-2">Watch Recording</div>
              </div>
              <p className="text-xs text-slate-600 mt-4">
                If the DVR is stolen or footage is edited, there's no way to prove what changed.
              </p>
            </div>
            <div className="glass-panel-accent rounded-2xl p-6">
              <p className="text-xs uppercase tracking-widest text-accent-500 mb-4">CrimeLens</p>
              <div className="space-y-2 text-sm text-slate-200 mono">
                <div className="border border-accent-500/20 bg-ink-900 rounded-lg px-3 py-2">Camera</div>
                <div className="text-center text-accent-500/50">↓</div>
                <div className="border border-accent-500/20 bg-ink-900 rounded-lg px-3 py-2">Real Recording</div>
                <div className="text-center text-accent-500/50">↓</div>
                <div className="border border-accent-500/20 bg-ink-900 rounded-lg px-3 py-2">Evidence Protection</div>
                <div className="text-center text-accent-500/50">↓</div>
                <div className="border border-accent-500/20 bg-ink-900 rounded-lg px-3 py-2">Hash Chain</div>
                <div className="text-center text-accent-500/50">↓</div>
                <div className="border border-accent-500/20 bg-ink-900 rounded-lg px-3 py-2">Blockchain Proof</div>
                <div className="text-center text-accent-500/50">↓</div>
                <div className="border border-accent-500/20 bg-ink-900 rounded-lg px-3 py-2">Verification</div>
              </div>
            </div>
          </div>
        </section>

        {/* Feature strip */}
        <section className="border-t border-ink-800 py-20">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6 text-center">
            {[
              { icon: ScanSearch, label: "Real-time tamper detection" },
              { icon: Blocks, label: "Algorand Testnet anchoring" },
              { icon: Link2, label: "Hash-linked chain of custody" },
              { icon: QrCode, label: "Public QR verification" },
            ].map((f) => (
              <div key={f.label} className="flex flex-col items-center gap-2">
                <f.icon className="text-accent-500" size={20} />
                <p className="text-xs text-slate-500">{f.label}</p>
              </div>
            ))}
          </div>
        </section>

        <footer className="border-t border-ink-800 py-8">
          <p className="flex items-center justify-center gap-2 text-center text-xs text-slate-600">
            <Camera size={13} /> <FileCheck2 size={13} /> CrimeLens -- capture, protect, verify. Hackathon prototype.
          </p>
        </footer>
      </div>
    </div>
  );
}
