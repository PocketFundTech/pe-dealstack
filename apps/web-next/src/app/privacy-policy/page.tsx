import type { Metadata } from "next";
import {
  LegalH2,
  LegalH3,
  LegalList,
  LegalP,
  LegalPageShell,
} from "@/components/layout/LegalPageShell";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "Avise Privacy Policy. Learn how we collect, use, and protect your data when you use our private equity platform.",
};

export default function PrivacyPolicyPage() {
  return (
    <LegalPageShell
      title="Privacy Policy"
      lastUpdated="February 5, 2026"
      activeFooterLink="privacy"
    >
      <section>
        <LegalH2>1. Introduction</LegalH2>
        <LegalP>
          Avise (&quot;we,&quot; &quot;our,&quot; or &quot;us&quot;) is committed to protecting your
          privacy. This Privacy Policy explains how we collect, use, disclose,
          and safeguard your information when you use our AI-powered private
          equity operating system platform.
        </LegalP>
        <LegalP>
          By accessing or using Avise, you agree to the terms of this Privacy
          Policy. If you do not agree with the terms of this Privacy Policy,
          please do not access the platform.
        </LegalP>
      </section>

      <section>
        <LegalH2>2. Information We Collect</LegalH2>
        <LegalH3>2.1 Information You Provide</LegalH3>
        <LegalList>
          <li>Account registration information (name, email, company, role)</li>
          <li>Deal and portfolio data you upload or enter</li>
          <li>Documents uploaded to the Virtual Data Room (VDR)</li>
          <li>Communications with our support team</li>
          <li>Payment and billing information</li>
        </LegalList>
        <LegalH3>2.2 Automatically Collected Information</LegalH3>
        <LegalList>
          <li>Device information and browser type</li>
          <li>IP address and location data</li>
          <li>Usage patterns and feature interactions</li>
          <li>Log data and analytics</li>
        </LegalList>
      </section>

      <section>
        <LegalH2>3. How We Use Your Information</LegalH2>
        <LegalP>We use the information we collect to:</LegalP>
        <LegalList>
          <li>Provide, maintain, and improve our services</li>
          <li>Process and analyze deal data using AI/ML models</li>
          <li>Generate insights, reports, and recommendations</li>
          <li>Send you updates, security alerts, and support messages</li>
          <li>Detect, prevent, and address technical issues</li>
          <li>Comply with legal obligations</li>
        </LegalList>
      </section>

      <section>
        <LegalH2>4. Data Security</LegalH2>
        <LegalP>
          We implement industry-standard security measures to protect your
          data:
        </LegalP>
        <LegalList>
          <li>AES-256 encryption for data at rest</li>
          <li>TLS 1.3 encryption for data in transit</li>
                    <li>Immutable, insert-only audit logging</li>
          <li>Role-based access controls</li>
          <li>Multi-factor authentication support</li>
        </LegalList>
      </section>

      <section>
        <LegalH2>5. Data Sharing and Disclosure</LegalH2>
        <LegalP>
          We do not sell your personal information. We may share your
          information only in the following circumstances:
        </LegalP>
        <LegalList>
          <li>
            <strong>Service Providers:</strong> With trusted third parties who
            assist in operating our platform
          </li>
          <li>
            <strong>Legal Requirements:</strong> When required by law or to
            protect our rights
          </li>
          <li>
            <strong>Business Transfers:</strong> In connection with a merger,
            acquisition, or sale of assets
          </li>
          <li>
            <strong>With Your Consent:</strong> When you explicitly authorize
            sharing
          </li>
        </LegalList>
      </section>

      <section>
        <LegalH2>6. Your Rights</LegalH2>
        <LegalP>You have the right to:</LegalP>
        <LegalList>
          <li>Access and receive a copy of your personal data</li>
          <li>Correct inaccurate or incomplete data</li>
          <li>Request deletion of your data</li>
          <li>Object to or restrict processing of your data</li>
          <li>Data portability</li>
          <li>Withdraw consent at any time</li>
        </LegalList>
      </section>

      <section>
        <LegalH2>7. Data Retention</LegalH2>
        <LegalP>
          We retain your information for as long as your account is active or
          as needed to provide services. Upon account termination, we will
          delete or anonymize your data within 90 days, unless retention is
          required by law or for legitimate business purposes.
        </LegalP>
      </section>

      <section>
        <LegalH2>8. Cookies and Tracking</LegalH2>
        <LegalP>
          We use cookies and similar technologies to enhance your experience,
          analyze usage patterns, and deliver personalized content. You can
          manage cookie preferences through your browser settings.
        </LegalP>
      </section>

      <section>
        <LegalH2>9. Changes to This Policy</LegalH2>
        <LegalP>
          We may update this Privacy Policy from time to time. We will notify
          you of any changes by posting the new Privacy Policy on this page and
          updating the &quot;Last updated&quot; date.
        </LegalP>
      </section>

      <section className="bg-[#f1f5f9] rounded-xl p-8">
        <LegalH2>10. Contact Us</LegalH2>
        <LegalP>
          If you have questions about this Privacy Policy or our data
          practices, please contact us:
        </LegalP>
        <div className="text-slate-600 space-y-2">
          <p>
            <strong>Email:</strong> hello@pocket-fund.com
          </p>
          <p>
            <strong>Website:</strong>{" "}
            <a
              href="https://pocket-fund.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              pocket-fund.com
            </a>
          </p>
        </div>
      </section>
    </LegalPageShell>
  );
}
