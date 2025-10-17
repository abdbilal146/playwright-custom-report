
import { Reporter, TestCase, TestResult, FullResult } from "@playwright/test/reporter";
import fs from "fs";
import path from "path";
import nodemailer from "nodemailer";
import axios from "axios";

// Fonction pour supprimer les codes ANSI
function stripAnsiCodes(str: string): string {
    return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
}

// Fonction pour extraire les tags depuis test.info().tags
function extractTags(test: TestCase): string[] {
    const tags = test.tags || [];
    return tags.length > 0 ? tags : ["Aucun tag"];
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
            if (!data.customTags["payment_method"]) data.customTags["payment_method"] = [];
            (data.customTags["payment_method"] as string[]).push(tag.replace("@payment_method:", ""));
        } else if (tag.startsWith("@") && tag.includes(":")) {
            const [key, value] = tag.slice(1).split(":");
            data.customTags[key] = value;
        }
    }

    if (data.local === "N/A" || data.realm === "N/A" ) {
        console.warn(`Missing data for test "${testTitle}":`, data);
    }

    return data;
}

class CustomEmailReporter implements Reporter {
    private tests: Map<
        string,
        Array<{
            title: string;
            location: string;
            duration: number;
            status: string;
            rawError?: string;
            expected?: string[];
            actual?: string[];
            tags: string[];
            local: string;
            realm: string;
            customTags: { [key: string]: string | string[] };
        }>
    > = new Map();

    onTestEnd(test: TestCase, result: TestResult) {
        const loc = test.location ? `${path.basename(test.location.file)}:${test.location.line}` : "unknown";
        const describeName = test.parent?.title || "Tests sans describe";
        const tags = extractTags(test);

        // Extraire les données des tags
        const { local, realm, customTags } = extractDataFromTags(tags, test.title);

        const testData: {
            title: string;
            location: string;
            duration: number;
            status: string;
            tags: string[];
            local: string;
            realm: string;
            customTags: {[key: string]: string | string[]} ;
            rawError?: string;
            expected?: string[];
            actual?: string[];
        } = {
            title: test.title,
            location: loc,
            duration: result.duration,
            status: result.status,
            tags,
            local,
            realm,
            customTags,
            rawError: undefined,
            expected: undefined,
            actual: undefined,
        };

        if (result.status === "failed") {
            for (const error of result.errors) {
                const raw = error.message || "No error message";
                const cleanedRaw = stripAnsiCodes(raw);
                const expected = Array.from(raw.matchAll(/Expected(?: value)?:\s*([^\n]+)/gi)).map((m) =>
                    stripAnsiCodes(m[1].trim())
                );
                const actual = Array.from(raw.matchAll(/(?:Received|Actual):\s*([^\n]+)/gi)).map((m) =>
                    stripAnsiCodes(m[1].trim())
                );
                testData.rawError = cleanedRaw;
                testData.expected = expected;
                testData.actual = actual;
            }
        }

        const tests = this.tests.get(describeName) || [];
        tests.push(testData);
        this.tests.set(describeName, tests);
    }

    async onEnd(result: FullResult) {
        if (this.tests.size === 0) {
            console.log("✅ Aucun test à rapporter.");
            return;
        }

        // Statistiques détaillées
        let totalTests = 0;
        let totalPassed = 0;
        let totalFailed = 0;
        let totalSkipped = 0;
        let allPaymentMethods: string[] = [];
        let allLocals: Set<string> = new Set();
        let allRealms: Set<string> = new Set();

        for (const tests of this.tests.values()) {
            for (const t of tests) {
                totalTests++;
                if (t.status === "passed") totalPassed++;
                else if (t.status === "failed") totalFailed++;
                else if (t.status === "skipped") totalSkipped++;
                allLocals.add(t.local);
                allRealms.add(t.realm);
                if (
                    Object.prototype.hasOwnProperty.call(t.customTags, "payment_method")
                    && t.customTags["payment_method"]
                ) {
                    if (Array.isArray(t.customTags["payment_method"])) {
                        allPaymentMethods.push(...(t.customTags["payment_method"] as string[]));
                    } else if (typeof t.customTags["payment_method"] === "string") {
                        allPaymentMethods.push(t.customTags["payment_method"] as string);
                    }
                }
            }
        }
        // Uniques et triés
        allPaymentMethods = Array.from(new Set(allPaymentMethods)).sort();

        // Générer le rapport HTML complet
        const fullReportHtml = `
      <!DOCTYPE html>
      <html lang="fr">
      <head>
        <meta charset="UTF-8" />
        <title>Master Data Automation Tests</title>
        <style>
          body { font-family: 'Segoe UI', sans-serif; background-color: #f6f8fa; color: #333; padding: 20px; }
          h1 { color: #d63031; }
          .describe { margin-bottom: 20px; }
          .describe-header { background: #d63031; color: #fff; padding: 10px; border-radius: 5px; cursor: pointer; font-weight: bold; font-size: 18px; display: flex; justify-content: space-between; align-items: center; }
          .describe-header:hover { background: #b71c1c; }
          .describe-content { display: none; padding: 10px 0; }
          .describe-content.active { display: block; }
          .test { background: #fff; padding: 16px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
          .test.failed { border-left: 5px solid #d63031; }
          .test.passed { border-left: 5px solid #27ae60; }
          .test.skipped { border-left: 5px solid #f39c12; }
          .title { font-weight: bold; font-size: 17px; margin-bottom: 6px; }
          .meta { font-size: 13px; color: #555; margin-bottom: 10px; }
          .raw-error { 
            background: #ffeaea; 
            color: #b71c1c; 
            padding: 10px; 
            border-radius: 5px; 
            font-family: monospace; 
            font-size: 14px; 
            white-space: pre-wrap; 
            margin-bottom: 10px; 
          }
          .payment-method{
            font-weight: bold;
            color: #2c3e50ff;
            padding-right: 10px;
            margin-right: 30px;
            
          }
          .details { margin-top: 10px; font-size: 14px; background: #f1f1f1; padding: 10px; border-radius: 5px; }
          .details div { margin-bottom: 4px; }
          .details span { display: inline-block; font-weight: bold; width: 90px; }
          .tags { font-size: 13px; color: #2f4f4f; margin-top: 8px; }
          .tags span { font-weight: bold; }
          .status-passed { color: #2ecc71; font-weight:600 }
          .status-failed { color: #e74c3c; font-weight:600 }
          footer { margin-top: 40px; font-size: 12px; color: #999; text-align: center; }
        </style>
        <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
        <script>
          function toggleDescribe(id) {
            const content = document.getElementById(id);
            content.classList.toggle('active');
            const header = content.previousElementSibling;
            header.textContent = header.textContent.includes('▼') ? 
              header.textContent.replace('▼', '▶') : 
              header.textContent.replace('▶', '▼');
          }
          window.onload = function() {
            const ctx = document.getElementById('testStatsChart');
            if (ctx) {
              new Chart(ctx, {
                type: 'doughnut',
                data: {
                  labels: ['Passés', 'Échoués', 'Ignorés'],
                  datasets: [{
                    data: [${totalPassed}, ${totalFailed}, ${totalSkipped}],
                    backgroundColor: ['#27ae60', '#d63031', '#f39c12'],
                  }]
                },
                options: {
                  responsive: false,
                  plugins: {
                    legend: { position: 'bottom' }
                  }
                }
              });
            }
          }
        </script>
      </head>
      <body>
        <h1>📊 Master Data Automation Report</h1>
        <div style="background:#fff;border-radius:8px;box-shadow:0 1px 4px #ccc;padding:18px 24px 10px 24px;max-width:900px;margin:0 auto 24px auto;">
          <h2 style="color:#0e4ba1;margin-top:0;">Statistiques Générales</h2>
          <div style="font-size:1.1em;">
            <b>Total tests :</b> ${totalTests} &nbsp;|&nbsp;
            <span style="color:#2ecc71;"><b>Passed :</b> ${totalPassed}</span> &nbsp;|&nbsp;
            <span style="color:#e74c3c;"><b>Failed :</b> ${totalFailed}</span> &nbsp;|&nbsp;
            <span style="color:#f39c12;"><b>Ignored :</b> ${totalSkipped}</span>
          </div>
          <div style="margin-top:10px;">
            <b>Tested locales:</b> ${Array.from(allLocals).join(", ")}
          </div>
          <div style="margin-top:4px;">
            <b>Tested Realms:</b> ${Array.from(allRealms).join(", ")}
          </div>
          <div style="margin-top:4px;">
            <b>Payment Methods encountred:</b> ${allPaymentMethods.length ? allPaymentMethods.join(", ") : "Aucune"}
          </div>
          <div style="margin-top:18px;text-align:center;">
            <canvas id="testStatsChart" width="350" height="220"></canvas>
          </div>
        </div>
        ${Array.from(this.tests.entries())
            .map(
                ([describeName, tests], index) => `
          <div class="describe">
            <div class="describe-header" onclick="toggleDescribe('describe-${index}')">
              ${describeName} (${tests.length} test${tests.length > 1 ? "s" : ""}) ▶
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
                          ? `<div><span class="payment-method">payment_method:</span> ${paymentMethods.join(", ")}</div>`
                          : "";

                        // Détermine la classe de statut pour la bordure
                        let statusClass = "failed";
                        if (t.status === "passed") statusClass = "passed";
                        else if (t.status === "skipped") statusClass = "skipped";

                        return `
                <div class="test ${statusClass}">
                  <div class="title">${t.title}</div>
                  <div class="meta">
                    📁 ${t.location} | ⏱️ ${t.duration}ms | 
                    <span class="status-${t.status}">${t.status.toUpperCase()}</span> | 
                    <span>Local:</span> ${t.local} | 
                    <span>Realm:</span> ${t.realm}
                  </div>
                  <div class="details">
                    ${Object.entries(t.customTags)
                        .filter(([key]) => key !== "payment_method")
                        .map(([key, value]) => `<div><span>${key}:</span> ${value}</div>`)
                        .join("")}
                    ${paymentMethodsHtml}
                  </div>
                  <div class="tags"><span>Tags:</span> ${t.tags.join(", ")}</div>
                  ${t.rawError ? `<div class="raw-error">${t.rawError}</div>` : ""}
                  ${(t.expected?.length || t.actual?.length) ? `
                    <div class="details">
                      ${t.expected?.map((e, i) => `<div><span>Expected ${i + 1}:</span> ${e}</div>`).join("")}
                      ${t.actual?.map((a, i) => `<div><span>Actual ${i + 1}:</span> ${a}</div>`).join("")}
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
          Rapport généré le ${new Date().toLocaleString()} — Playwright API Tests
        </footer>
      </body>
      </html>
    `;

        // Sauvegarder le rapport HTML complet
        const reportPath = "costum-report/full-test-report.html";
        fs.writeFileSync(reportPath, fullReportHtml, "utf-8");
        console.log("✅ Rapport HTML complet généré : full-test-report.html");
    }
}

export default CustomEmailReporter;
