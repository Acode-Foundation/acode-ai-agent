import { mount } from "pele";
import type { AcodeMermaidRuntime } from "../platform/pluginAssets";

const runtime: AcodeMermaidRuntime = {
  mount(container, source, onError) {
    // Links would navigate the WebView away from Acode, and images fetch remote URLs.
    const diagram = mount(container, source, { links: false, images: false, onError });
    return () => {
      diagram.destroy();
      container.replaceChildren();
    };
  },
};

window.acodeAiMermaidRuntime = runtime;
