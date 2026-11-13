import { BrowserRouter, Link, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { StatusProvider } from "./hooks/useStatus";
import { CarePage } from "./pages/CarePage";
import { CaregiverPage } from "./pages/CaregiverPage";
import { LandingPage } from "./pages/LandingPage";
import { PilotPage } from "./pages/PilotPage";
import "./scene/scene.css";

function NotFound() {
  return (
    <div className="container not-found">
      <h1>Page not found</h1>
      <p>
        Go to the <Link to="/">start page</Link>, or use the links above to open Pilot, Care or Caregiver.
      </p>
    </div>
  );
}

export function App() {
  return (
    <StatusProvider>
      <BrowserRouter>
        <Routes>
          <Route index element={<LandingPage />} />
          <Route element={<Layout />}>
            <Route path="pilot" element={<PilotPage />} />
            <Route path="care" element={<CarePage />} />
            <Route path="caregiver" element={<CaregiverPage />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </StatusProvider>
  );
}
