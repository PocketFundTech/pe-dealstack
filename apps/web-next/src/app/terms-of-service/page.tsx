import type { Metadata } from "next";
import {
  LegalH2,
  LegalH3,
  LegalList,
  LegalP,
  LegalPageShell,
} from "@/components/layout/LegalPageShell";

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "Avise Terms of Service. Read our terms and conditions for using the Avise platform.",
};

export default function TermsOfServicePage() {
  return (
    <LegalPageShell
      title="Terms of Service"
      lastUpdated="February 5, 2026"
      activeFooterLink="terms"
    >
      <section>
        <LegalH2>1. Agreement to Terms</LegalH2>
        <LegalP>
          These Terms of Service (&quot;Terms&quot;) constitute a legally binding
          agreement between you and Avise (&quot;Company,&quot; &quot;we,&quot;
          &quot;us,&quot; or &quot;our&quot;) governing your access to and use of our
          AI-powered private equity operating system platform.
        </LegalP>
        <LegalP>
          By creating an account or using our services, you acknowledge that
          you have read, understood, and agree to be bound by these Terms. If
          you do not agree, you may not access or use our services.
        </LegalP>
      </section>

      <section>
        <LegalH2>2. Eligibility</LegalH2>
        <LegalP>
          You must be at least 18 years old and have the legal authority to
          enter into these Terms on behalf of yourself or the organization you
          represent. By using Avise, you represent and warrant that you meet
          these eligibility requirements.
        </LegalP>
      </section>

      <section>
        <LegalH2>3. Account Registration</LegalH2>
        <LegalP>To access our services, you must:</LegalP>
        <LegalList>
          <li>Provide accurate and complete registration information</li>
          <li>Maintain the security of your account credentials</li>
          <li>Promptly notify us of any unauthorized access</li>
          <li>Accept responsibility for all activities under your account</li>
        </LegalList>
      </section>

      <section>
        <LegalH2>4. Acceptable Use</LegalH2>
        <LegalP>You agree not to:</LegalP>
        <LegalList>
          <li>Violate any applicable laws or regulations</li>
          <li>Upload malicious code, viruses, or harmful content</li>
          <li>Attempt to gain unauthorized access to our systems</li>
          <li>Interfere with the proper functioning of the platform</li>
          <li>Use the service for any illegal or unauthorized purpose</li>
          <li>Reverse engineer, decompile, or disassemble our software</li>
          <li>Share account credentials with unauthorized parties</li>
          <li>Scrape, harvest, or extract data from our platform</li>
        </LegalList>
      </section>

      <section>
        <LegalH2>5. Intellectual Property</LegalH2>
        <LegalH3>5.1 Our Property</LegalH3>
        <LegalP>
          Avise, including its software, design, features, AI models, and
          content, is owned by us and protected by intellectual property laws.
          You receive a limited, non-exclusive, non-transferable license to use
          the platform in accordance with these Terms.
        </LegalP>
        <LegalH3>5.2 Your Content</LegalH3>
        <LegalP>
          You retain ownership of the data and content you upload to Avise. By
          uploading content, you grant us a limited license to process, store,
          and analyze your data solely to provide our services to you.
        </LegalP>
      </section>

      <section>
        <LegalH2>6. Subscription and Payment</LegalH2>
        <LegalList>
          <li>
            Subscription fees are billed in advance on a monthly or annual
            basis
          </li>
          <li>All fees are non-refundable except as required by law</li>
          <li>We reserve the right to change pricing with 30 days&apos; notice</li>
          <li>
            Failure to pay may result in suspension or termination of services
          </li>
          <li>You are responsible for all applicable taxes</li>
        </LegalList>
      </section>

      <section>
        <LegalH2>7. Confidentiality</LegalH2>
        <LegalP>
          We understand the sensitive nature of private equity data. We commit
          to maintaining strict confidentiality of your data and will not
          disclose your information to third parties except as outlined in our
          Privacy Policy or as required by law.
        </LegalP>
      </section>

      <section>
        <LegalH2>8. Disclaimers</LegalH2>
        <div className="bg-[#fef3c7] border border-[#f59e0b] rounded-xl p-6 mb-4">
          <p className="text-[#92400e] leading-relaxed">
            <strong>Important:</strong> Avise provides tools and AI-generated
            insights for informational purposes only. Our platform does not
            constitute financial, legal, or investment advice. You are solely
            responsible for your investment decisions.
          </p>
        </div>
        <LegalP>
          THE SERVICE IS PROVIDED &quot;AS IS&quot; WITHOUT WARRANTIES OF ANY KIND,
          EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF
          MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND
          NON-INFRINGEMENT.
        </LegalP>
      </section>

      <section>
        <LegalH2>9. Limitation of Liability</LegalH2>
        <LegalP>
          TO THE MAXIMUM EXTENT PERMITTED BY LAW, Avise SHALL NOT BE LIABLE FOR
          ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE
          DAMAGES, INCLUDING BUT NOT LIMITED TO LOSS OF PROFITS, DATA, OR
          BUSINESS OPPORTUNITIES, ARISING FROM YOUR USE OF THE SERVICE.
        </LegalP>
      </section>

      <section>
        <LegalH2>10. Indemnification</LegalH2>
        <LegalP>
          You agree to indemnify and hold harmless Avise and its officers,
          directors, employees, and agents from any claims, damages, losses, or
          expenses arising from your use of the service, violation of these
          Terms, or infringement of any third-party rights.
        </LegalP>
      </section>

      <section>
        <LegalH2>11. Termination</LegalH2>
        <LegalP>
          Either party may terminate these Terms at any time. You may cancel
          your subscription through your account settings. We may suspend or
          terminate your access if you violate these Terms.
        </LegalP>
        <LegalP>
          Upon termination, your right to use the service will immediately
          cease. We will retain your data for 90 days to allow for export,
          after which it will be permanently deleted.
        </LegalP>
      </section>

      <section>
        <LegalH2>12. Governing Law</LegalH2>
        <LegalP>
          These Terms shall be governed by and construed in accordance with the
          laws of the State of Delaware, without regard to its conflict of law
          provisions. Any disputes shall be resolved in the state or federal
          courts located in Delaware.
        </LegalP>
      </section>

      <section>
        <LegalH2>13. Changes to Terms</LegalH2>
        <LegalP>
          We reserve the right to modify these Terms at any time. We will
          provide notice of material changes via email or through the platform.
          Your continued use of the service after changes become effective
          constitutes acceptance of the revised Terms.
        </LegalP>
      </section>

      <section className="bg-[#f1f5f9] rounded-xl p-8">
        <LegalH2>14. Contact Information</LegalH2>
        <LegalP>For questions about these Terms, please contact us:</LegalP>
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
