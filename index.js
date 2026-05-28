const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

// Load env manually (don't require dotenv to keep it simple)
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const envFile = fs.readFileSync(envPath, 'utf-8');
    envFile.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim();
          if (!process.env[key]) process.env[key] = val;
        }
      }
    });
  }
}
loadEnv();

const app = express();
const PORT = process.env.PORT || 3001;

// CORS — allow our GitHub Pages domain
app.use(cors({
  origin: [
    'https://keathstone.github.io',
    'http://localhost:5500',
    'http://127.0.0.1:5500'
  ],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
  maxAge: 86400
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Upload directory for temp files
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `ticket-${Date.now()}${path.extname(file.originalname || '.jpg')}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files allowed'));
  }
});

// Initialize Anthropic
let anthropic = null;
try {
  if (process.env.ANTHROPIC_API_KEY) {
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    console.log('Anthropic client initialized');
  } else {
    console.warn('No ANTHROPIC_API_KEY found — letter generation will use local matching only');
  }
} catch (e) {
  console.error('Failed to init Anthropic:', e.message);
}

// In-memory trial tracking (per IP, resets on server restart)
const trialUsage = new Map();
const TRIAL_MAX = 5; // 5 free disputes per IP during trial
const isTrial = (ip) => {
  const count = trialUsage.get(ip) || 0;
  return count < TRIAL_MAX;
};
const incrementTrial = (ip) => {
  trialUsage.set(ip, (trialUsage.get(ip) || 0) + 1);
};

// ===== HEALTH CHECK =====
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    anthropic: !!anthropic,
    disputes_generated: [...trialUsage.values()].reduce((a, b) => a + b, 0),
    trials_active: trialUsage.size
  });
});

// ===== READ TICKET PHOTO =====
app.post('/api/read-ticket', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });

    const imagePath = req.file.path;
    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString('base64');
    const mimeType = req.file.mimetype || 'image/jpeg';

    let extractedData;

    // Try Opus for highest accuracy
    if (anthropic) {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text',
              text: `This is a photo of a DOT/FMCSA violation citation or inspection report. Extract ALL visible information as a JSON object with these fields. Be thorough — read every line. Only fill fields that are actually visible in the photo:

{
  "carrier_name": "",
  "dot_number": "",
  "driver_name": "",
  "driver_license_state": "",
  "driver_license_number": "",
  "violation_date": "",
  "violation_time": "",
  "city": "",
  "state": "",
  "citation_number": "",
  "officer_name": "",
  "officer_department": "",
  "regulation_cited": "",
  "regulation_text": "",
  "violation_description": "",
  "vehicle_inspected": "",
  "license_plate": "",
  "location_description": "",
  "all_text_from_ticket": ""
}

CRITICAL: Put the COMPLETE raw text from the ticket in "all_text_from_ticket". Every section, every line, every number, every checkbox, every handwritten note. Include inspection level, vehicle type, BASIC code, time weight, and any out-of-service designations.`
            },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mimeType,
                data: base64Image
              }
            }
          ]
        }]
      });

      const text = response.content[0].text;
      try {
        // Extract JSON from response
        const jsonMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) || text.match(/\{[\s\S]*?\}/);
        extractedData = jsonMatch ? JSON.parse(jsonMatch[1]) : { all_text_from_ticket: text, raw_response: text };
      } catch {
        extractedData = { all_text_from_ticket: text, raw_response: text };
      }
    } else {
      // Fallback: return placeholder
      extractedData = {
        all_text_from_ticket: '[Image uploaded but no AI service configured. Manual entry required.]',
        fallback: true
      };
    }

    // Clean up uploaded file
    try { fs.unlinkSync(imagePath); } catch(e) {}

    res.json({
      success: true,
      data: extractedData
    });

  } catch (error) {
    console.error('read-ticket error:', error.message);
    // Clean up on error
    if (req.file) try { fs.unlinkSync(req.file.path); } catch(e) {}
    res.status(500).json({ error: 'Failed to read ticket: ' + error.message });
  }
});

// ===== GENERATE DISPUTE LETTER =====
app.post('/api/generate-letter', async (req, res) => {
  try {
    const { ticketData, driverStory, carrierName = '[CARRIER LEGAL NAME]' } = req.body;
    if (!ticketData && !driverStory) {
      return res.status(400).json({ error: 'At least ticket data or driver story required' });
    }

    const ip = req.ip || req.connection.remoteAddress || 'unknown';

    const data = ticketData || {};
    const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const story = driverStory || data.violation_description || '[driver explanation pending]';
    const regCited = data.regulation_cited || '[regulation cited]';
    const regText = data.regulation_text || '';
    const ticketedDate = data.violation_date || '[date]';
    const ticketedCity = data.city || '[city]';
    const ticketedState = data.state || '[state]';

    let legalArgument = '';

    if (anthropic) {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2500,
        messages: [{
          role: 'user',
          content: `You are a legal assistant specializing in FMCSA regulations and DataQs dispute letters. Generate a professional, lawyer-grade regulatory analysis for a DataQs dispute.

VIOLATION DETAILS:
Regulation cited: ${regCited}
Regulation text: ${regText}
Driver explanation: ${story}
Ticket description: ${data.violation_description || ''}

Write 3-4 sentences of regulatory analysis that:
1. Cites the exact regulation (49 C.F.R. §)
2. Explains what the regulation actually requires
3. Analyzes whether the driver's situation fits the regulation
4. Concludes with why the citation should be challenged

Be specific. Reference actual subsections. Sound like a transportation attorney.`
        }]
      });
      legalArgument = response.content[0].text;
    } else {
      legalArgument = `The cited regulation (${regCited}) must be analyzed in the context of the specific facts presented. ${regText ? regText + ' ' : ''}The undersigned maintains that the enforcement action lacks sufficient factual basis under FMCSA standards and applicable precedent. Photographic evidence is submitted for the Board's review.`;
    }

    // Build evidence list
    const evidenceList = [];
    if (data.all_text_from_ticket) evidenceList.push('Exhibit A: Copy of violation citation');
    evidenceList.push('Exhibit(s) B: Photographic evidence of vehicle/equipment condition');

    const letter = `
                              DATAQs FORMAL DISPUTE
                     Filed Pursuant to 49 C.F.R. § 386.72
                             FMCSA DataQs System

Date of Filing: ${today}
----------------------------------------------------------------------

I. PARTIES

Motor Carrier:        ${carrierName}
USDOT Number:         ${data.dot_number || '[DOT NUMBER]'}
Driver Name:          ${data.driver_name || '[DRIVER FULL NAME]'}
Driver License:       ${data.driver_license_state || '[STATE]'} CDL No. ${data.driver_license_number || '[LICENSE NUMBER]'}
Date of Violation:    ${ticketedDate}
Location:             ${ticketedCity}${ticketedCity ? ', ' : ''}${ticketedState || '[STATE]'}
Citation No.:         ${data.citation_number || '[CITATION NUMBER]'}
Inspecting Officer:   ${data.officer_name || '[OFFICER NAME]'}
Vehicle:              ${data.vehicle_inspected || data.license_plate || '[VEHICLE INFO]'}

----------------------------------------------------------------------

II. CHALLENGED VIOLATION

${regCited ? `Regulation: 49 C.F.R. § ${regCited}` : ''}
${regText ? `\nRegulation text: ${regText}` : ''}

Officer's Account: ${story}

${data.location_description ? `\nLocation context: ${data.location_description}` : ''}

----------------------------------------------------------------------

III. REGULATORY ANALYSIS

${legalArgument}

----------------------------------------------------------------------

IV. LEGAL ARGUMENT

Pursuant to 49 C.F.R. § 386.72(a), a motor carrier or driver may request
the FMCSA to review any violation record that is believed to be
inaccurate or unsupported.

The undersigned respectfully submits that the citation described above:

1. Misapplies the regulation cited;
2. Fails to account for the actual condition of the vehicle/equipment
   as demonstrated by the attached photographic evidence; and
3. Imposes an undue regulatory burden inconsistent with FMCSA's stated
   mission of promoting safety through reasonable enforcement.

The FMCSA's own guidance on DataQs proceedings states that violations
may be removed where "the regulation cited does not apply to the
specific facts." The specific facts here compel removal.

----------------------------------------------------------------------

V. SUPPORTING EVIDENCE

${evidenceList.join('\n')}

The undersigned certifies that the attached photographic evidence is a
true and accurate depiction of the vehicle/equipment condition at or
near the time of the citation and has not been altered or manipulated.

${data.all_text_from_ticket ? '\nThe complete text of the citation is reproduced below for the Board\'s reference:\n' + data.all_text_from_ticket : ''}

----------------------------------------------------------------------

VI. REQUEST FOR RELIEF

WHEREFORE, based upon the foregoing facts, regulatory analysis, and
supporting evidence, the undersigned respectfully requests that the
FMCSA DataQs Review Board:

(a) Conduct a full review of the challenged violation;
(b) Determine that the cited regulation does not apply to the facts
    presented herein;
(c) Remove the violation from the motor carrier's and driver's CSA
    Safety Measurement System (SMS) record; and
(d) Issue a written determination consistent with this request.

----------------------------------------------------------------------

VII. CERTIFICATION

I hereby certify, under penalty of perjury and in accordance with 28
U.S.C. § 1746, that the foregoing statements are true and correct to
the best of my knowledge, information, and belief.

Executed on: ${today}

______________________________________
[DRIVER SIGNATURE]

______________________________________
[MOTOR CARRIER REPRESENTATIVE]

----------------------------------------------------------------------
DISCLAIMER: This document was prepared with the assistance of automated
tools and is not a substitute for legal representation. The filer is
encouraged to review all content for accuracy before submission.
`;

    // Track usage
    incrementTrial(ip);

    res.json({
      success: true,
      letter,
      trial: {
        remaining: TRIAL_MAX - (trialUsage.get(ip) || 0),
        is_trial: true
      },
      reg_analysis: legalArgument
    });

  } catch (error) {
    console.error('generate-letter error:', error.message);
    res.status(500).json({ error: 'Failed to generate letter: ' + error.message });
  }
});

// ===== TRIAL STATUS =====
app.get('/api/trial-status', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const used = trialUsage.get(ip) || 0;
  res.json({
    disputes_used: used,
    disputes_remaining: Math.max(0, TRIAL_MAX - used),
    trial_days_remaining: 60,
    is_trial: used < TRIAL_MAX
  });
});

// ===== START =====
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Trucker Dispute Server running on port ${PORT}`);
  console.log(`Anthropic: ${anthropic ? 'CONNECTED' : 'NOT CONNECTED (fallback mode)'}`);
  console.log(`Trial limit: ${TRIAL_MAX} disputes per IP`);
});
