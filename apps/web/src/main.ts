import "./styles.css";
import { mountApp } from "./App.js";

const root = document.querySelector<HTMLElement>("#app");
if (root) mountApp(root);
