import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "FINN: portfolio filings and research",
    short_name: "FINN",
    description: "What changed across your Indian equity portfolio, why it matters, and what the filings actually say.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f7f5ef",
    theme_color: "#123f3a",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
