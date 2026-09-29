import { useState } from "react";
import { createRoot } from "react-dom/client";
import { api } from "./api.js";

/** A minimal interface exercising the generated, typed HTTP client. */
function Application() {
  const [name, setName] = useState("World");
  const [message, setMessage] = useState("");
  return <main><h1>Kestrel application</h1><form onSubmit={(event) => {
    event.preventDefault();
    void api.example.greet({ name }).then((result) => setMessage(result.message)).catch(() => setMessage("The request failed."));
  }}><label>Name <input value={name} onChange={(event) => setName(event.target.value)} required /></label><button>Greet</button></form><p role="status">{message}</p></main>;
}

createRoot(document.getElementById("root")!).render(<Application />);
