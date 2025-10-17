import { Reporter, TestCase, TestResult, FullResult } from "@playwright/test/reporter";
import fs from "fs";
import path from "path";
import nodemailer from "nodemailer";
import axios from "axios";
import dotenv from 'dotenv'
dotenv.config()

let WEB_HOOK_URL = process.env.WEB_HOOK_URL
// Fonction pour supprimer les codes ANSI
function stripAnsiCodes(str: string): string {
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
}

// Fonction pour extraire les tags depuis test.info().tags
function extractTags(test: TestCase): string[] {
  const tags = test.tags || [];
  return tags.length > 0 ? tags : ["No tags"];
}

// Fonction pour parser les tags et extraire les données
function extractDataFromTags(tags: string[], testTitle: string): {
  local: string;
  realm: string;
  customTags: { [key: string]: string | string[] };
} {
  const data = {
    local: "N/A",
    realm: "N/A",
    customTags: {},
  };

  for (const tag of tags) {
    if (tag.startsWith("@local:") || tag.startsWith("@locale:")) {
      data.local = tag.replace(/^@(local|locale):/, "");
    } else if (tag.startsWith("@realm:")) {
      data.realm = tag.replace("@realm:", "");
    } else if (tag.startsWith("@payment_method:")) {
      // Ajoute toutes les méthodes de paiement dans un tableau
      if (!data.customTags["payment_method"]) data.customTags["payment_method"] = [];
      (data.customTags["payment_method"] as string[]).push(tag.replace("@payment_method:", ""));
    } else if (tag.startsWith("@") && tag.includes(":")) {
      const [key, value] = tag.slice(1).split(":");
      data.customTags[key] = value;
    }
  }

  // Avertissement si des données clés sont manquantes
  if (data.local === "N/A" || data.realm === "N/A") {
    console.warn(`Missing data for test "${testTitle}":`, data);
  }

  return data;
}

// Ajoutez cette fonction utilitaire en haut du fichier (après les imports)
function extractPaymentMethodsFromTags(tags: string[]): string[] {
  return tags
    .filter(tag => tag.startsWith('@payment_method:'))
    .map(tag => tag.replace('@payment_method:', ''));
}

class CustomEmailReporter implements Reporter {
  private failedTests: Map<
    string,
    Array<{
      title: string;
      location: string;
      duration: number;
      rawError: string;
      expected: string[];
      actual: string[];
      tags: string[];
      local: string;
      realm: string;
      customTags: { [key: string]: string | string[] };
    }>
  > = new Map();

  onTestEnd(test: TestCase, result: TestResult) {
    if (result.status !== "failed") return;

    const loc = test.location ? `${path.basename(test.location.file)}:${test.location.line}` : "unknown";
    const describeName = test.parent?.title || "Tests without describe";
    const tags = extractTags(test);

    // Extraire les données des tags
    const { local, realm, customTags } = extractDataFromTags(tags, test.title);

    for (const error of result.errors) {
      const raw = error.message || "No error message";
      const cleanedRaw = stripAnsiCodes(raw);
      const expected = Array.from(raw.matchAll(/Expected(?: value)?:\s*([^\n]+)/gi)).map((m) =>
        stripAnsiCodes(m[1].trim())
      );
      const actual = Array.from(raw.matchAll(/(?:Received|Actual):\s*([^\n]+)/gi)).map((m) =>
        stripAnsiCodes(m[1].trim())
      );

      const tests = this.failedTests.get(describeName) || [];
      tests.push({
        title: test.title,
        location: loc,
        duration: result.duration,
        rawError: cleanedRaw,
        expected,
        actual,
        tags,
        local,
        realm,
        customTags, // <-- ensure this is the correct type
      });
      this.failedTests.set(describeName, tests);
    }
  }

  async onEnd(result: FullResult) {
    if (this.failedTests.size === 0) {
      console.log("✅ All tests passed, no report to generate.");
      return;
    }

    // Calculate total execution time
    const totalDuration = Array.from(this.failedTests.values())
      .flat()
      .reduce((sum, test) => sum + test.duration, 0);

    // Trouver tous les tags personnalisés uniques pour chaque describe
    const customTagKeysByDescribe: { [describeName: string]: Set<string> } = {};
    for (const [describeName, tests] of this.failedTests) {
      const customTagKeys = new Set<string>();
      for (const test of tests) {
        Object.keys(test.customTags).forEach((key) => customTagKeys.add(key));
      }
      customTagKeysByDescribe[describeName] = customTagKeys;
    }

    // Générer le rapport HTML complet
    const fullReportHtml = `
      <!DOCTYPE html>
      <html lang="fr">
      <head>
        <meta charset="UTF-8" />
        <title>Master Data Failed Tests</title>
        <link href="https://fonts.googleapis.com/css?family=Montserrat:400,700&display=swap" rel="stylesheet">
        <style>
          body {
            font-family: 'Montserrat', Arial, sans-serif;
            background: linear-gradient(135deg, #e0eafc 0%, #cfdef3 100%);
            color: #222;
            margin: 0;
            padding: 0;
          }
          header {
            background: linear-gradient(90deg, #0e4ba1 0%, #90baf3 100%);
            color: #fff;
            padding: 32px 0 24px 0;
            text-align: center;
            box-shadow: 0 2px 8px rgba(0,0,0,0.07);
            margin-bottom: 32px;
          }
          header img {
            height: 48px;
            vertical-align: middle;
            margin-right: 16px;
          }
          h1 {
            font-size: 2.2em;
            margin: 0;
            letter-spacing: 1px;
            font-weight: 700;
          }
          .execution-time {
            font-family: 'Montserrat', Arial, sans-serif;
            background: #27ae60;
            color: #fff;
            font-weight: bold;
            font-size: 1.15em;
            border-radius: 8px;
            padding: 12px 24px;
            margin: 0 auto 24px auto;
            max-width: 900px;
            text-align: center;
            box-shadow: 0 1px 6px rgba(39,174,96,0.10);
            letter-spacing: 1px;
          }
          .summary {
            max-width: 900px;
            margin: 0 auto 32px auto;
            background: #fff;
            border-radius: 12px;
            box-shadow: 0 2px 12px rgba(0,0,0,0.07);
            padding: 24px 32px;
            display: flex;
            align-items: center;
            gap: 32px;
          }
          .summary-icon {
            font-size: 2.5em;
            color: #d63031;
            margin-right: 16px;
          }
          .summary-details {
            font-size: 1.1em;
          }
          .describe {
            max-width: 900px;
            margin: 0 auto 32px auto;
          }
          .describe-header {
            background: linear-gradient(90deg, #d63031 0%, #ff7675 100%);
            color: #fff;
            padding: 14px 20px;
            border-radius: 8px;
            cursor: pointer;
            font-weight: bold;
            font-size: 1.15em;
            margin-bottom: 6px;
            box-shadow: 0 1px 6px rgba(0,0,0,0.06);
            display: flex;
            justify-content: space-between;
            align-items: center;
            transition: background 0.2s;
          }
          .describe-header:hover {
            background: linear-gradient(90deg, #b71c1c 0%, #d63031 100%);
          }
          .describe-content {
            display: none;
            padding: 0 0 10px 0;
          }
          .describe-content.active {
            display: block;
          }
          .test-card {
            background: #fff;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.08);
            margin-bottom: 18px;
            padding: 20px 28px;
            transition: box-shadow 0.2s;
            border-left: 7px solid #d63031;
          }
          .test-card:hover {
            box-shadow: 0 4px 18px rgba(0,0,0,0.13);
          }
          .title {
            font-weight: bold;
            font-size: 1.15em;
            margin-bottom: 8px;
            color: #0e4ba1;
          }
          .meta {
            font-size: 0.98em;
            color: #555;
            margin-bottom: 10px;
            display: flex;
            gap: 18px;
            flex-wrap: wrap;
          }
          .meta span {
            font-weight: 600;
            color: #d63031;
          }
          .raw-error {
            background: #ffeaea;
            color: #b71c1c;
            padding: 12px;
            border-radius: 6px;
            font-family: 'Fira Mono', monospace;
            font-size: 1em;
            white-space: pre-wrap;
            margin-bottom: 10px;
            border: 1px solid #d63031;
            box-shadow: 0 1px 4px rgba(214,48,49,0.07);
          }
          .details {
            margin-top: 10px;
            font-size: 1em;
            background: #f1f1f1;
            padding: 10px 14px;
            border-radius: 6px;
          }
          .details div {
            margin-bottom: 4px;
          }
          .details span {
            display: inline-block;
            font-weight: bold;
            width: 120px;
            color: #0e4ba1;
          }
          .tags {
            font-size: 0.95em;
            color: #2f4f4f;
            margin-top: 8px;
            background: #eafcda;
            padding: 6px 12px;
            border-radius: 6px;
            display: inline-block;
          }
          .tags span {
            font-weight: bold;
            color: #27ae60;
          }
          footer {
            margin-top: 48px;
            font-size: 0.95em;
            color: #999;
            text-align: center;
            padding-bottom: 24px;
          }
        </style>
        <script>
          function toggleDescribe(id) {
            const content = document.getElementById(id);
            content.classList.toggle('active');
            const header = content.previousElementSibling;
            header.textContent = header.textContent.includes('▼') ?
              header.textContent.replace('▼', '▶') :
              header.textContent.replace('▶', '▼');
          }
        </script>
      </head>
      <body>
        <header>
          <img src="https://cdn-icons-png.flaticon.com/512/1828/1828665.png" alt="Error Icon"/>
          <h1>❌ Master Data Failed Tests</h1>
        </header>
        <div class="execution-time">
          ⏳ Total Execution Time: ${totalDuration} ms
        </div>
        <div class="summary">
          <span class="summary-icon">🚨</span>
          <div class="summary-details">
            <strong>${this.failedTests.size}</strong> describe block(s) with failed tests.<br>
            <strong>${Array.from(this.failedTests.values()).reduce((acc, arr) => acc + arr.length, 0)}</strong> total failed test(s).
            <br>Report generated on <strong>${new Date().toLocaleString()}</strong>
          </div>
        </div>
        ${Array.from(this.failedTests.entries())
        .map(
          ([describeName, tests], index) => `
          <div class="describe">
            <div class="describe-header" onclick="toggleDescribe('describe-${index}')">
              ${describeName} (${tests.length} failed test${tests.length > 1 ? "s" : ""}) ▶
            </div>
            <div class="describe-content" id="describe-${index}">
              ${tests
              .map(
                (t, ti) => {
                  // Affichage correct des méthodes de paiement uniquement si présentes
                  let paymentMethods: string[] = [];
                  if (
                    Object.prototype.hasOwnProperty.call(t.customTags, "payment_method")
                    && t.customTags["payment_method"]
                  ) {
                    if (Array.isArray(t.customTags["payment_method"])) {
                      paymentMethods = t.customTags["payment_method"] as string[];
                    } else if (typeof t.customTags["payment_method"] === "string") {
                      paymentMethods = [t.customTags["payment_method"] as string];
                    }
                  }
                  const paymentMethodsHtml = paymentMethods.length
                    ? `<div><span>payment_method:</span> ${paymentMethods.join(", ")}</div>`
                    : "";

                  return `
                <div class="test-card">
                  <div class="title">🧪 ${t.title}</div>
                  <div class="meta">
                    <span>📁 ${t.location}</span>
                    <span>⏱️ ${t.duration}ms</span>
                    <span>🌍 Local: ${t.local}</span>
                    <span>🔒 Realm: ${t.realm}</span>
                  </div>
                  <span><h4 style="margin:10px 0 6px 0;color:#27ae60;">Expected Data</h4></span>
                  <div class="details">
                    ${Object.entries(t.customTags)
                      .filter(([key]) => key !== "payment_method")
                      .map(([key, value]) => `<div><span>${key}:</span> ${value}</div>`)
                      .join("")}
                    ${paymentMethodsHtml}
                  </div>
                  <div class="tags"><span>Tags:</span> ${t.tags.join(", ")}</div>
                  <div class="raw-error"><strong>❗ Error:</strong><br>${t.rawError}</div>
                  ${(t.expected.length || t.actual.length) ? `
                    <div class="details">
                      ${t.expected.map((e, i) => `<div><span>Expected ${i + 1}:</span> ${e}</div>`).join("")}
                      ${t.actual.map((a, i) => `<div><span>Actual ${i + 1}:</span> ${a}</div>`).join("")}
                    </div>
                  ` : ""}
                </div>
              `;
                }
              )
              .join("")}
            </div>
          </div>
        `
        )
        .join("")}
        <footer>
          <hr style="border:none;border-top:1px solid #eee;margin-bottom:16px;">
          Report generated on ${new Date().toLocaleString()} — Playwright API Tests<br>
          <p><strong>Abd-ElFetah Mancer</strong> | Data Integrity Team | 18, rue du 4 septembre 75002 Paris | LV_NEO | Tel : 0638034143</p>
        </footer>
      </body>
      </html>
    `;

    // Sauvegarder le rapport HTML complet
    const reportPath = "costum-report/failed-report.html";
    fs.writeFileSync(reportPath, fullReportHtml, "utf-8");
    console.log("✅ Full HTML report generated: failed-report.html");

    // Générer un rapport HTML simplifié pour l'email avec tableaux dynamiques
    const emailBodyHtml = `
      <!DOCTYPE html>
      <html lang="fr">
      <head>
        <meta charset="UTF-8" />
        <title>Master Data Failed Tests</title>
        <link href="https://fonts.googleapis.com/css?family=Montserrat:400,700&display=swap" rel="stylesheet">
        <style>
          body {
            font-family: 'Montserrat', Arial, sans-serif;
            color: #222;
            background: #f4f4f4;
            margin: 0;
            padding: 0;
          }
          .email-container {
            max-width: 900px;
            margin: 0 auto;
            background: #fff;
            border-radius: 8px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.07);
            padding: 32px 24px;
          }
          h1 {
            color: #d63031;
            font-size: 2em;
            margin-bottom: 10px;
            font-weight: bold;
          }
          p {
            font-size: 1em;
            margin-bottom: 18px;
          }
          h2 {
            color: #0e4ba1;
            font-size: 1.1em;
            margin: 20px 0 10px 0;
          }
          table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 18px;
            background: #fff;
            border-radius: 6px;
            overflow: hidden;
            box-shadow: 0 1px 4px rgba(0,0,0,0.06);
          }
          th, td {
            border: 1px solid #e0e0e0;
            padding: 8px 6px;
            text-align: left;
            font-size: 0.98em;
          }
          th {
            background: #0e4ba1;
            color: #fff;
            font-weight: bold;
          }
          tr:nth-child(even) {
            background: #f4f8fb;
          }
          tr:nth-child(odd) {
            background: #fff;
          }
          .error {
            color: #b71c1c;
            font-family: monospace;
            white-space: pre-wrap;
            background: #ffeaea;
            padding: 6px;
            border-radius: 3px;
            font-weight: bold;
            border: 1px solid #d63031;
          }
          .details {
            font-size: 0.97em;
          }
          .details div {
            margin: 4px 0;
          }
          .details span {
            font-weight: bold;
            display: inline-block;
            width: 80px;
            color: #0e4ba1;
          }
          .tags {
            font-size: 0.95em;
            color: #2f4f4f;
            background: #eafcda;
            padding: 3px 8px;
            border-radius: 3px;
          }
          .execution-time {
            font-family: 'Montserrat', Arial, sans-serif;
            background: #27ae60;
            color: #fff;
            font-weight: bold;
            font-size: 1.1em;
            border-radius: 8px;
            padding: 10px 20px;
            margin: 0 auto 18px auto;
            max-width: 900px;
            text-align: center;
            box-shadow: 0 1px 6px rgba(39,174,96,0.10);
            letter-spacing: 1px;
          }
          footer {
            margin-top: 24px;
            font-size: 0.95em;
            color: #999;
            text-align: center;
          }
        </style>
      </head>
      <body>
        <div class="email-container">
          <h1>❌ Master Data Failed Tests</h1>
          <p> Dear All </p>
          <div class="execution-time">
            ⏳ Total Execution Time: ${totalDuration} ms
          </div>
          <p>Please find attached the full report. Summary of failed tests:</p>
          <div style="margin-bottom:14px;">
            <strong>${this.failedTests.size}</strong> describe block(s) with failed tests.<br>
            <strong>${Array.from(this.failedTests.values()).reduce((acc, arr) => acc + arr.length, 0)}</strong> total failed test(s).
            <br>Report generated on <strong>${new Date().toLocaleString()}</strong>
          </div>
          ${Array.from(this.failedTests.entries())
          .map(([describeName, tests]) => {
            const customTagKeys = Array.from(customTagKeysByDescribe[describeName] || []);
            return `
            <div>
              <h2>${describeName} (${tests.length} failed test${tests.length > 1 ? "s" : ""})</h2>
              <table>
                <tr>
                  <th>Test</th>
                  <th>Local</th>
                  <th>Realm</th>
                  ${customTagKeys.map((key) => `<th>${key}</th>`).join("")}
                  <th>Error</th>
                  <th>Details</th>
                </tr>
                ${tests
                .map(
                  (t) => `
                  <tr>
                    <td>${t.title}</td>
                    <td>${t.local}</td>
                    <td>${t.realm}</td>
                    ${customTagKeys.map((key) => `<td>${t.customTags[key] || "N/A"}</td>`).join("")}
                    <td class="error">${t.rawError}</td>
                    <td class="details">
                      ${(t.expected.length || t.actual.length) ? `
                        ${t.expected.map((e, i) => `<div><span>Expected ${i + 1}:</span> ${e}</div>`).join("")}
                        ${t.actual.map((a, i) => `<div><span>Actual ${i + 1}:</span> ${a}</div>`).join("")}
                      ` : "No details"}
                    </td>
                  </tr>
                `
                )
                .join("")}
              </table>
            </div>
          `;
          })
          .join("")}
          <footer>
            <hr style="border:none;border-top:1px solid #eee;margin-bottom:12px;">
            Report generated on ${new Date().toLocaleString()} — Playwright API Tests<br>
            <p><strong>Abd-ElFetah Mancer</strong> | Data Integrity Team | 18, rue du 4 septembre 75002 Paris | LV_NEO | Tel : 0638034143</p>
          </footer>
        </div>
      </body>
      </html>
    `;

    // Générer une version texte brut pour l'email
    const textSummary = Array.from(this.failedTests.entries())
      .map(
        ([describeName, tests]) => {
          const customTagKeys = Array.from(customTagKeysByDescribe[describeName] || []);
          return `${describeName} (${tests.length} failed test${tests.length > 1 ? "s" : ""})\n` +
            tests
              .map(
                (t) =>
                  `  - ${t.title} (File: ${t.location}, Time: ${t.duration}ms, Local: ${t.local}, Realm: ${t.realm
                  }, ${customTagKeys
                    .map((key) => `${key}: ${t.customTags[key] || "N/A"}`)
                    .join(", ")}, Tags: ${t.tags.join(", ")})\n    Error: ${t.rawError}\n`
              )
              .join("");
        }
      )
      .join("\n");

    // Envoyer le message à Microsoft Teams via un webhook
    const webhookUrl = WEB_HOOK_URL;
    if (webhookUrl) {
      const totalFailed = Array.from(this.failedTests.values()).reduce((acc, arr) => acc + arr.length, 0);
      const totalDescribe = this.failedTests.size;
      const teamsPayload = {
        "@type": "MessageCard",
        "@context": "http://schema.org/extensions",
        themeColor: "d63031",
        summary: "❌ Master Data Failed Tests",
        title: "❌ Master Data Failed Tests",
        sections: [
          {
            activityTitle: "❌ <span style='color:#d63031;font-size:18px;font-weight:bold;'>Master Data Failed Tests</span>",
            activitySubtitle: `Generated on ${new Date().toLocaleString()}`,
            text: [
              `**Total Failed Tests:** <span style='color:#d63031;font-weight:bold;'>${totalFailed}</span>`,
              `**Describe Blocks:** <span style='color:#0e4ba1;font-weight:bold;'>${totalDescribe}</span>`,
              `**Total Execution Time:** <span style='color:#27ae60;font-weight:bold;'>${totalDuration} ms</span>`,
              "",
              "Check your email for the full HTML report."
            ].join("<br>"),
            facts: [
              {
                name: "Total Failed Tests",
                value: `${totalFailed}`
              },
              {
                name: "Describe Blocks",
                value: `${totalDescribe}`
              },
              {
                name: "Total Execution Time",
                value: `${totalDuration} ms`
              }
            ]
          },
          ...Array.from(this.failedTests.entries()).map(([describeName, tests]) => {
            const customTagKeys = Array.from(customTagKeysByDescribe[describeName] || []);
            return {
              title: `**${describeName}** (${tests.length} failed test${tests.length > 1 ? "s" : ""})`,
              facts: tests.map((t) => {
                // Extraction des méthodes de paiement depuis customTags (tableau)
                let paymentMethods: string[] = [];
                if (Array.isArray(t.customTags["payment_method"])) {
                  paymentMethods = t.customTags["payment_method"] as string[];
                } else if (typeof t.customTags["payment_method"] === "string") {
                  paymentMethods = [t.customTags["payment_method"] as string];
                }
                const paymentMethodsLine = paymentMethods.length
                  ? `**Payment Methods:** ${paymentMethods.join(", ")}`
                  : "";

                // Flatten expected and actual arrays to single lines
                const expectedLine = t.expected.length ? `Expected: ${t.expected.join(" | ")}` : "";
                const actualLine = t.actual.length ? `Actual: ${t.actual.join(" | ")}` : "";
                return {
                  name: `🧪 ${t.title}`,
                  value: [
                    `**File:** ${t.location}`,
                    `**Time:** ${t.duration}ms`,
                    `**Local:** ${t.local}`,
                    `**Realm:** ${t.realm}`,
                    ...customTagKeys
                      .filter((key) => key !== "payment_method")
                      .map((key) => `**${key}:** ${t.customTags[key] || "N/A"}`),
                    paymentMethodsLine,
                    `**Tags:** ${t.tags.join(", ")}`,
                    `<span style="color:#27ae60;"><strong>Error:</strong> ${t.rawError.replace(/\n/g, " ")}</span>`,
                    expectedLine,
                    actualLine
                  ].filter(Boolean).join(" | ")
                };
              }),
            };
          }),
        ],
      };

      try {
        await axios.post(webhookUrl, teamsPayload);
        console.log("📢 Message sent successfully to Microsoft Teams.");
      } catch (error) {
        console.error("❌ Error sending message to Teams:", {
          message: error.message,
          code: error.code,
          response: error.response?.data || "No response",
        });
      }
    } else {
      console.warn("⚠️ TEAMS_WEBHOOK_URL not defined. Teams message not sent.");
    }

    // Configurer le transporteur SMTP
    const transporter = nodemailer.createTransport({
      host: "smtp.vuitton.lvmh",
      port: 25,
    });

    // Vérifier la connexion au serveur SMTP
    try {
      await transporter.verify();
      console.log("✅ SMTP server connection verified successfully.");
    } catch (error) {
      console.error("❌ Error verifying SMTP transporter:", {
        message: error.message,
        code: error.code,
        response: error.response || "No response",
        stack: error.stack,
      });
      return;
    }

    // Configurer les options de l'email
    const mailOptions = {
      from: "abd-elfetah.mancer.ext@louisvuitton.com",
      to: "abd-elfetah.mancer.ext@louisvuitton.com",
      subject: `Master Data Failed Tests Report - ${new Date().toLocaleString()}`,
      text: textSummary,
      html: emailBodyHtml,
      attachments: [
        {
          filename: "full-test-report.html",
          path: "costum-report/full-test-report.html",
        },
      ],
    };

    // Envoyer l'email avec logique de réessai
    const sendEmailWithRetry = async (transporter, mailOptions, retries = 3, delay = 1000) => {
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          await transporter.sendMail(mailOptions);
          console.log("📧 Email sent successfully.");
          return;
        } catch (error) {
          console.error(`❌ Attempt ${attempt} failed:`, {
            message: error.message,
            code: error.code,
            response: error.response || "No response",
            stack: error.stack,
          });
          if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
      console.error("❌ All email sending attempts failed.");
    };

    await sendEmailWithRetry(transporter, mailOptions);
  }
}

export default CustomEmailReporter;
