import { lazy, Suspense, useEffect } from "react";
import { Link } from "react-router-dom";
import { Brand } from "../components/Layout";
import { SignFigure } from "../components/landing/SignFigure";
import { BUILD, HERO, HOSPITAL, LIMITS, LOOP, RESULTS, SECTIONS, SIGN_CAPTION } from "../text/landingWording";
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

        <section className="band band--tint" id="hospital" aria-labelledby="h-hospital">
          <div className="container band-grid">
            <h2 id="h-hospital">{SECTIONS.hospital}</h2>
            <div>
              <p className="band-lead">{HOSPITAL.lead}</p>
              <ul className="plain-list">
                {HOSPITAL.points.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
              <p className="band-note">{HOSPITAL.note}</p>
            </div>
          </div>
        </section>

        <section className="band" id="results" aria-labelledby="h-results">
          <div className="container band-grid">
            <h2 id="h-results">{SECTIONS.results}</h2>
            <div className="results">
              <div>
                <h3>
                  {RESULTS.simTitle} <span className="results-note">{RESULTS.simNote}</span>
                </h3>
                <dl className="figures">
                  {RESULTS.figures.map((f) => (
                    <div key={f.label}>
                      <dt>{f.label}</dt>
                      <dd>{f.value}</dd>
                    </div>
                  ))}
                </dl>
                <p>{RESULTS.closest}</p>
              </div>
              <div>
                <h3>{RESULTS.realTitle}</h3>
                <p>{RESULTS.real}</p>
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
            <div className="hardware">
              <dl className="build">
                {BUILD.map((b) => (
                  <div key={b.term}>
                    <dt>{b.term}</dt>
                    <dd>{b.detail}</dd>
                  </div>
                ))}
              </dl>
              <figure className="sign-figure">
                <SignFigure />
                <figcaption>{SIGN_CAPTION}</figcaption>
              </figure>
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
