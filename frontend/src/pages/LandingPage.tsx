import { lazy, Suspense, useEffect } from "react";
import { Link } from "react-router-dom";
import { Brand } from "../components/Layout";
import { SignFigure } from "../components/landing/SignFigure";
import { BUILD, HERO, HOP_FIGURES, HOP_POINTS, HOSPITAL, LIMITS, LOOP, RESULTS, SECTIONS } from "../text/landingWording";
import { FOOTER_TEXT } from "../text/wording";
import "./landing.css";

// The live demo runs the simulator inside the page, so only the browser build has it. The check is on the
// build-time constant itself, so the other build does not even contain the demo's code (see transport/index.ts).
const LiveDemo =
  import.meta.env.VITE_BACKEND === "browser"
    ? lazy(() => import("../components/landing/LandingDemo").then((m) => ({ default: m.LandingDemo })))
    : null;

export function LandingPage() {
  useEffect(() => {
    document.title = "MedHop";
  }, []);

  return (
    <div className="app landing">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="masthead">
        <div className="masthead-inner container">
          <Brand />
          <nav aria-label="On this page" className="nav">
            <ul>
              <li className="landing-nav-extra">
                <a href="#how">{SECTIONS.how}</a>
              </li>
              <li className="landing-nav-extra">
                <a href="#hospital">Hospital</a>
              </li>
              <li className="landing-nav-extra">
                <a href="#results">Results</a>
              </li>
              <li className="landing-nav-extra">
                <a href="#limits">Limits</a>
              </li>
              <li>
                <Link className="btn btn-primary btn-sm" to="/pilot">
                  Open the app
                </Link>
              </li>
            </ul>
          </nav>
        </div>
      </header>

      <main id="main" tabIndex={-1}>
        <section className="hero container">
          <h1 className="hero-title">{HERO.title}</h1>
          <p className="hero-lead">{LiveDemo ? HERO.lead : HERO.leadLocal}</p>
          {LiveDemo ? (
            <Suspense fallback={<div className="demo-loading" aria-hidden="true" />}>
              <LiveDemo />
            </Suspense>
          ) : (
            <div className="demo-actions row">
              <Link className="btn btn-primary btn-lg" to="/pilot">
                Open the Pilot page
              </Link>
            </div>
          )}
        </section>

        <section className="band" id="how" aria-labelledby="h-how">
          <div className="container band-grid">
            <h2 id="h-how">{SECTIONS.how}</h2>
            <ol className="loop">
              {LOOP.map((step, i) => (
                <li key={step.title}>
                  <span className="loop-n" aria-hidden="true">
                    {i + 1}
                  </span>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="band" id="hospital" aria-labelledby="h-hospital">
          <div className="container band-grid">
            <h2 id="h-hospital">{SECTIONS.hospital}</h2>
            <div>
              <p className="band-lead">{HOSPITAL.lead}</p>
              <ul className="points">
                {HOSPITAL.points.map((point) => (
                  <li key={point.title}>
                    <h3>{point.title}</h3>
                    <p>{point.body}</p>
                  </li>
                ))}
              </ul>
              <p className="figures-note">{HOSPITAL.figuresNote}</p>
              <dl className="figures figures-three">
                {HOSPITAL.figures.map((f) => (
                  <div key={f.label}>
                    <dt>{f.label}</dt>
                    <dd>{f.value}</dd>
                  </div>
                ))}
              </dl>
              <h3 className="cannot-title">{HOSPITAL.cannotTitle}</h3>
              <ul className="plain-list">
                {HOSPITAL.cannot.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section className="band" aria-labelledby="h-hop">
          <div className="container band-grid">
            <h2 id="h-hop">{SECTIONS.hop}</h2>
            <div>
              <dl className="figures">
                {HOP_FIGURES.map((f) => (
                  <div key={f.label}>
                    <dt>{f.label}</dt>
                    <dd>{f.value}</dd>
                  </div>
                ))}
              </dl>
              <div className="hop">
                <ul className="plain-list">
                  {HOP_POINTS.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
                <figure className="sign-figure">
                  <SignFigure />
                  <figcaption>The station sign, as printed.</figcaption>
                </figure>
              </div>
            </div>
          </div>
        </section>

        <section className="band" id="results" aria-labelledby="h-results">
          <div className="container band-grid">
            <h2 id="h-results">{SECTIONS.results}</h2>
            <div className="results">
              <div>
                <h3>{RESULTS.simTitle}</h3>
                <p>{RESULTS.simNote}</p>
                <ul className="plain-list">
                  {RESULTS.sim.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h3>{RESULTS.realTitle}</h3>
                {RESULTS.real.map((p) => (
                  <p key={p}>{p}</p>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="band" id="limits" aria-labelledby="h-limits">
          <div className="container band-grid">
            <h2 id="h-limits">{SECTIONS.limits}</h2>
            <ul className="plain-list">
              {LIMITS.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        </section>

        <section className="band" aria-labelledby="h-build">
          <div className="container band-grid">
            <h2 id="h-build">{SECTIONS.build}</h2>
            <dl className="build">
              {BUILD.map((b) => (
                <div key={b.term}>
                  <dt>{b.term}</dt>
                  <dd>{b.detail}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className="band band--last" aria-label="Open the app">
          <div className="container closing">
            <p className="closing-text">The whole app runs here too.</p>
            <div className="row">
              <Link className="btn btn-primary btn-lg" to="/pilot">
                Fly the drone
              </Link>
              <Link className="btn btn-lg" to="/care">
                Care page
              </Link>
              <Link className="btn btn-lg" to="/caregiver">
                Caregiver page
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="container">{FOOTER_TEXT}</div>
      </footer>
    </div>
  );
}
