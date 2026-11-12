import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { StatusProvider } from "./hooks/useStatus";
import { CarePage } from "./pages/CarePage";
import { CaregiverPage } from "./pages/CaregiverPage";
import { PilotPage } from "./pages/PilotPage";

function NotFound() {
  return (
    <div className="container not-found">
      <h1>Page not found</h1>
      <p>Use the navigation above to open Pilot, Care or Caregiver.</p>
    </div>
  );
}

export function App() {
  return (
    <StatusProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<PilotPage />} />
            <Route path="care" element={<CarePage />} />
            <Route path="caregiver" element={<CaregiverPage />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </StatusProvider>
  );
}
