import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Static site-wide social preview — no og:image existed before this, so
// every link share (Slack, LinkedIn, X) rendered a blank card. Text-only,
// no external assets, so it can't drift out of sync with anything.
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "80px",
          backgroundColor: "#003366",
          backgroundImage: "linear-gradient(135deg, #003366 0%, #0055AA 100%)",
        }}
      >
        <div
          style={{
            fontSize: 40,
            fontWeight: 700,
            color: "#ffffff",
            letterSpacing: "-0.02em",
            marginBottom: 24,
          }}
        >
          Avise
        </div>
        <div
          style={{
            fontSize: 56,
            fontWeight: 800,
            color: "#ffffff",
            lineHeight: 1.15,
            maxWidth: 900,
          }}
        >
          Deal Flow Software for Search Funds &amp; PE Deal Teams
        </div>
        <div
          style={{
            fontSize: 28,
            color: "#cbd8e8",
            marginTop: 28,
          }}
        >
          Deal flow, CRM, and AI-powered deal analysis in one platform
        </div>
      </div>
    ),
    { ...size }
  );
}
