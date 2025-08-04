import React from "react";
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import Race from "../src/components/pages/Race/Race";
import "./App.css";

function App() {
  return (
    <div className="App">
      <Router>
        <Routes>
          <Route path="/" element={<Race />} />
          {/* You can add more routes here if needed */}
        </Routes>
      </Router>
    </div>
  );
}

export default App;
