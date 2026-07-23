import type { MetadataRoute } from "next";

/** Web app manifest — PWA install shell (issue #83 / ADR 0002). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "NutriBuddy",
    short_name: "NutriBuddy",
    description: "AI nutrition assistant — log meals, confirm proposals, get guidance.",
    start_url: "/chat",
    display: "standalone",
    background_color: "#f9fafb",
    theme_color: "#2563eb",
    orientation: "portrait-primary",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ],
  };
}
