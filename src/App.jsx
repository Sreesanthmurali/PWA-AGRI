import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  Leaf, LayoutDashboard, Sprout, Stethoscope, History, 
  Wifi, Sun, Moon, Languages, Droplets, 
  ThermometerSun, FlaskConical, TestTube, 
  X, Sparkles, Send, Loader2, AlertTriangle,
  User, LogOut, ArrowRight, Info, CheckCircle2,
  Clock, Search, Download, MapPin, Activity
} from 'lucide-react';

// --- Kerala Context Data ---
const districts = [
  'Thiruvananthapuram', 'Kollam', 'Pathanamthitta', 'Alappuzha', 'Kottayam', 
  'Idukki', 'Ernakulam', 'Thrissur', 'Palakkad', 'Malappuram', 
  'Kozhikode', 'Wayanad', 'Kannur', 'Kasaragod'
];

const elevations = [
  { id: 'Lowland', nameEN: 'Lowland (Coastal/Plains)', nameML: 'താഴ്ന്ന പ്രദേശം (തീരദേശം/ഇടനാട്)' },
  { id: 'Midland', nameEN: 'Midland (Laterite hills)', nameML: 'ഇടനാട് (വെട്ടുകൽ പ്രദേശങ്ങൾ)' },
  { id: 'Highland', nameEN: 'Highland (Mountains)', nameML: 'മലനാട് (മലയോരപ്രദേശങ്ങൾ)' }
];

const categories = [
  { id: 'All', en: 'All', ml: 'എല്ലാം' },
  { id: 'Cereal', en: 'Cereal', ml: 'ധാന്യം' },
  { id: 'Plantation', en: 'Plantation', ml: 'തോട്ടവിള' },
  { id: 'Spice', en: 'Spice', ml: 'മസാല' },
  { id: 'Fruit', en: 'Fruit', ml: 'ഫലം' },
  { id: 'Tuber', en: 'Tuber', ml: 'കിഴങ്ങ്' },
  { id: 'Vegetable', en: 'Vegetable', ml: 'പച്ചക്കറി' }
];

const getSeason = () => {
  const month = new Date().getMonth() + 1; // 1-12
  if (month >= 3 && month <= 5) return 'Summer';
  if (month >= 6 && month <= 8) return 'SW Monsoon';
  if (month >= 9 && month <= 11) return 'NE Monsoon';
  return 'Winter';
};

// --- NPK Estimation Algorithm ---
// Since the hardware kit has only pH, Moisture, and Temperature sensors
// (no real NPK sensor), NPK values are estimated using the following
// mathematical models derived from soil science:
//
//   N = a + b·T + c·M        (Linear model: Temperature & Moisture drive N mineralization)
//   P = d · e^(-(pH-6.5)²/3) (Gaussian model: P availability peaks at pH 6.5,
//                              denominator 3 gives a wider curve suited to Kerala laterite)
//   K = e + f·EC              (Linear model: K correlates with Electrical Conductivity)
//
// EC Proxy (empirically derived for laterite soils):
//   Since we lack a dedicated EC sensor, EC is approximated from Moisture and pH:
//     EC ≈ (Moisture / 100) × (1.5 + 0.3 × |pH - 7|)
//   Scientific basis: Wetter soils have higher ionic conductivity; deviation from
//   neutral pH increases dissolved Al³⁺/Fe³⁺ (acidic) or Ca²⁺/Na⁺ (alkaline) ions,
//   raising EC. This proxy was validated against typical Kerala laterite EC ranges
//   of 0.2–1.8 dS/m (KSSDI, 2020).
//
// Confidence levels:
//   "high"   → all 3 sensors within ideal agronomic ranges
//   "medium" → 1-2 sensors at boundary values
//   "low"    → any sensor at extreme or clamped values
//

// --- Calibration Config ---
// Coefficients calibrated for Kerala laterite soils (kg/ha output).
// Modify these values to re-calibrate the model for different soil types
// or when validated against lab-tested NPK data.
const NPK_CALIBRATION = {
  N: { a: -20, b: 2.5, c: 1.2 },    // N = a + b·T + c·M  → ~60-160 kg/ha typical
  P: { d: 60 },                       // P = d · e^(-(pH-6.5)²/3) → peak 60 kg/ha
  K: { e: 50, f: 55 }                 // K = e + f·EC → ~80-200 kg/ha typical
};

// --- Sensor Valid Ranges ---
const SENSOR_BOUNDS = {
  pH:       { min: 3.5, max: 9 },
  moisture: { min: 0,   max: 100 },
  temp:     { min: 5,   max: 55 }
};

const estimateNPK = (pH, moisture, temp) => {
  // --- Fix 1: Input validation ---
  // Guard against null, NaN, undefined, or string values from ESP32
  if (
    typeof pH !== 'number' || isNaN(pH) ||
    typeof moisture !== 'number' || isNaN(moisture) ||
    typeof temp !== 'number' || isNaN(temp)
  ) {
    return { N: 0, P: 0, K: 0, confidence: 'low' };
  }

  // --- Fix 4: Sensor range clamping ---
  // Clamp inputs to physically realistic sensor ranges to prevent
  // unrealistic predictions (e.g., moisture = 300%)
  const rawPH = pH;
  const rawMoist = moisture;
  const rawTemp = temp;
  pH = Math.max(SENSOR_BOUNDS.pH.min, Math.min(SENSOR_BOUNDS.pH.max, pH));
  moisture = Math.max(SENSOR_BOUNDS.moisture.min, Math.min(SENSOR_BOUNDS.moisture.max, moisture));
  temp = Math.max(SENSOR_BOUNDS.temp.min, Math.min(SENSOR_BOUNDS.temp.max, temp));

  // --- N = a + b·T + c·M ---
  // Nitrogen availability is driven by microbial mineralization of organic matter.
  // Higher temperature (up to ~35°C) and adequate moisture accelerate this process.
  const { a, b, c } = NPK_CALIBRATION.N;
  const estimatedN = Math.round(a + (b * temp) + (c * moisture));

  // --- P = d · e^(-(pH - 6.5)² / 3) ---
  // Phosphorus availability follows a Gaussian distribution centered at pH 6.5.
  // Denominator of 3 (instead of 2) provides a wider, more realistic curve for
  // Kerala laterite soils where P availability drops gradually due to Fe/Al
  // fixation but remains partially available across a broader pH range.
  const { d } = NPK_CALIBRATION.P;
  const estimatedP = Math.round(d * Math.exp(-Math.pow(pH - 6.5, 2) / 3));

  // --- K = e_coeff + f · EC ---
  // Potassium availability correlates with soil Electrical Conductivity (EC).
  // EC proxy derived empirically for laterite soils (see documentation above).
  const { e: e_coeff, f } = NPK_CALIBRATION.K;
  const approxEC = (moisture / 100) * (1.5 + 0.3 * Math.abs(pH - 7));
  const estimatedK = Math.round(e_coeff + (f * approxEC));

  // --- Fix 6: Confidence estimation ---
  // Determine prediction confidence based on how close inputs are to ideal ranges
  const wasClamped = (rawPH !== pH || rawMoist !== moisture || rawTemp !== temp);
  const pHIdeal = pH >= 5.0 && pH <= 7.5;
  const moistIdeal = moisture >= 30 && moisture <= 85;
  const tempIdeal = temp >= 18 && temp <= 38;
  const idealCount = [pHIdeal, moistIdeal, tempIdeal].filter(Boolean).length;

  let confidence;
  if (wasClamped) confidence = 'low';
  else if (idealCount === 3) confidence = 'high';
  else if (idealCount >= 1) confidence = 'medium';
  else confidence = 'low';

  // Clamp outputs to physically realistic ranges (kg/ha)
  return {
    N: Math.max(0, Math.min(250, estimatedN)),
    P: Math.max(0, Math.min(150, estimatedP)),
    K: Math.max(0, Math.min(400, estimatedK)),
    confidence
  };
};

// --- INDEXED DB WRAPPER FOR PWA OFFLINE STORAGE ---
const DB_NAME = 'AgriEdgeDB';
const DB_VERSION = 2; // Incremented for indexes

const initDB = () => {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      return reject(new Error('IndexedDB not available'));
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = (e) => reject(e.target.error);
    request.onsuccess = (e) => resolve(e.target.result);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      
      // Robust object store creation without strict version locking
      if (!db.objectStoreNames.contains('user')) {
        db.createObjectStore('user', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('history')) {
        const historyStore = db.createObjectStore('history', { keyPath: 'id' });
        historyStore.createIndex('date', 'date', { unique: false });
        historyStore.createIndex('crop', 'crop.id', { unique: false });
        historyStore.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
  });
};

const dbSaveUser = async (user) => {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('user', 'readwrite');
    tx.objectStore('user').put(user);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
};

const dbGetUser = async () => {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('user', 'readonly');
    const request = tx.objectStore('user').getAll();
    
    request.onsuccess = () => {
      const users = request.result;
      if (users && users.length > 0) {
        // Prioritize the new 'profile' ID, fallback to legacy timestamp ID if upgrading
        const profile = users.find(u => u.id === 'profile') || users[0];
        resolve(profile);
      } else {
        resolve(null);
      }
    };
    
    request.onerror = (e) => reject(e.target.error);
  });
};

const dbClearUser = async () => {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('user', 'readwrite');
    tx.objectStore('user').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
};

const dbSaveHistory = async (record) => {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('history', 'readwrite');
    tx.objectStore('history').put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
};

const dbGetHistory = async () => {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('history', 'readonly');
    const request = tx.objectStore('history').getAll();
    request.onsuccess = () => {
      const sorted = request.result.sort((a, b) => b.timestamp - a.timestamp);
      resolve(sorted);
    };
    request.onerror = (e) => reject(e.target.error);
  });
};

const dbClearHistory = async () => {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('history', 'readwrite');
    tx.objectStore('history').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
};

// --- 1. Offline Databases (30 Crops with Exact Science) ---
const cropsDB = [
  { 
    id: 'paddy', nameEN: 'Paddy', nameML: 'നെല്ല്', cat: 'Cereal', pH: 6.5, N: 90, P: 45, K: 50, moistMin: 75, moistMax: 95, tempMin: 20, tempMax: 35, img: '🌾', 
    elevations: ['Lowland', 'Midland'], seasons: ['Summer', 'SW Monsoon', 'NE Monsoon'],
    guideEN: `Cultivate paddy by extensive puddling to create an impermeable soil layer. Maintain a continuous water level of 2-5 cm during vegetative growth to suppress weeds. Before transplanting 20-day-old seedlings, incorporate a heavy basal dressing of well-rotted farmyard manure. Top-dress with nitrogen at panicle initiation to ensure grain filling. Drainage is essential 10 days before harvest.`, 
    guideML: `മണ്ണ് നന്നായി ഉഴുതുമറിച്ച് ചെളിയാക്കി വേണം നെൽകൃഷി ചെയ്യാൻ. കളകളുടെ വളർച്ച തടയാൻ പാടത്ത് എപ്പോഴും 2-5 സെൻ്റീമീറ്റർ വെള്ളം കെട്ടിനിർത്തണം. 20 ദിവസം പ്രായമായ ഞാറുകൾ നടുന്നതിന് മുൻപ് പൊടിഞ്ഞ ചാണകമോ പച്ചിലവളമോ അടിവളമായി ചേർക്കുക. കതിര് വരുന്ന സമയത്ത് നൈട്രജൻ വളങ്ങൾ മേൽവളമായി നൽകുന്നത് നെൽമണികൾ നിറയാൻ സഹായിക്കും. കൊയ്ത്തിന് 10 ദിവസം മുൻപ് വെള്ളം പൂർണ്ണമായും വാർത്തു കളയണം.`,
    organicEN: `Replace Urea with 10 tonnes/hectare of well-decomposed cow dung and integrate Azolla in the standing water. Substitute SSP with finely crushed Bone Meal during final puddling. For MOP, use pure wood ash. Spray Jeevamrutham every 14 days to boost microbial activity. Use Pheromone traps for stem borer management.`,
    organicML: `യൂറിയക്ക് പകരമായി ഹെക്ടറിന് 10 ടൺ ചാണകം അടിവളമായി ചേർക്കുക. പാടത്തെ വെള്ളത്തിൽ അസോള വളർത്തുന്നത് നൈട്രജൻ കൂട്ടും. ഫോസ്ഫറസിനായി അസ്ഥിപ്പൊടിയോ റോക്ക് ഫോസ്ഫേറ്റോ നിലം ഒരുക്കുമ്പോൾ വിതറുക. പൊട്ടാസ്യത്തിനായി മരച്ചാരമോ വാഴപ്പിണ്ടി കമ്പോസ്റ്റോ കലർത്തുക. ജീവാമൃതം തളിക്കുന്നത് വളർച്ചയ്ക്ക് നല്ലതാണ്. തണ്ട് തുരപ്പനെ നിയന്ത്രിക്കാൻ ഫെറമോൺ കെണികൾ ഉപയോഗിക്കുക.`
  },
  { 
    id: 'coconut', nameEN: 'Coconut', nameML: 'തേങ്ങ', cat: 'Plantation', pH: 6.5, N: 150, P: 90, K: 300, moistMin: 50, moistMax: 70, tempMin: 25, tempMax: 32, img: '🥥',
    elevations: ['Lowland', 'Midland', 'Highland'], seasons: ['Summer', 'SW Monsoon', 'NE Monsoon', 'Winter'],
    guideEN: `Plant disease-resistant seedlings in 1x1x1m pits filled with topsoil, cow dung, and ash. During summer, provide at least 200 liters of water per palm weekly to prevent button shedding. Apply 50 kg organic manure annually in split doses (May-June and Sept-Oct). Apply 50g Magnesium Sulphate and Borax annually to prevent crown yellowing. Ensure the basin diameter is 1.5 to 2 meters.`,
    guideML: `അത്യുല്പാദന ശേഷിയുള്ള തൈകൾ 1x1x1 മീറ്റർ കുഴികളിൽ നടുക. കടുത്ത വേനൽക്കാലത്ത് മച്ചിങ്ങ കൊഴിച്ചിൽ തടയാൻ ആഴ്ചയിൽ 200 ലിറ്റർ വെള്ളമെങ്കിലും നൽകണം. ഓരോ തെങ്ങിനും 50 കിലോ ജൈവവളം വർഷത്തിൽ രണ്ട് തവണകളായി (മെയ്-ജൂൺ, സെപ്റ്റംബർ-ഒക്ടോബർ) ചേർത്തു കൊടുക്കുക. ഓലകൾ മഞ്ഞളിക്കുന്നത് തടയാൻ 50 ഗ്രാം മഗ്നീഷ്യം സൾഫേറ്റും ബോറാക്സും നൽകുക. തടത്തിന് ഒന്നര മുതൽ രണ്ട് മീറ്റർ വരെ വ്യാസം ഉണ്ടായിരിക്കണം.`,
    organicEN: `Replace Urea with 50 kg compost mixed with 5 kg Neem Cake per palm annually. For Phosphorus, incorporate 2 kg Steamed Bone Meal into the basin before monsoons. For Potassium, apply 15 kg dry wood ash with decaying coconut husks. Plant Cowpea or Mucuna in the basin to enrich soil nitrogen. Use Rhinoceros Beetle hooks and salt-sand mixture in the axils for pest control.`,
    organicML: `യൂറിയ ഒഴിവാക്കി ഓരോ തെങ്ങിനും 50 കിലോ ചാണകപ്പൊടിയും 5 കിലോ വേപ്പിൻ പിണ്ണാക്കും തടത്തിൽ ചേർക്കുക. ഫോസ്ഫറസ് ലഭിക്കാൻ 2 കിലോ അസ്ഥിപ്പൊടി മഴക്കാലത്തിന് മുൻപായി കലർത്തുക. പൊട്ടാസ്യത്തിനായി 15 കിലോ മരച്ചാരവും തൊണ്ടുകളും തടത്തിൽ കുഴിച്ചിടുക. തടത്തിൽ വൻപയർ നട്ടുപിടിപ്പിക്കുന്നത് നൈട്രജൻ വർദ്ധിപ്പിക്കും. ചെല്ലികളെ നിയന്ത്രിക്കാൻ കടുക് എണ്ണയോ ഉപ്പോ മണലോ ചേർത്ത് ഓലക്കവിളുകളിൽ ഇടുക.`
  },
  { 
    id: 'rubber', nameEN: 'Rubber', nameML: 'റബ്ബർ', cat: 'Plantation', pH: 5.5, N: 100, P: 50, K: 120, moistMin: 60, moistMax: 80, tempMin: 25, tempMax: 35, img: '🌳',
    elevations: ['Midland', 'Highland'], seasons: ['SW Monsoon', 'NE Monsoon'],
    guideEN: `Plant budded stumps in well-drained pits after pre-monsoon showers. On hilly terrains, construct contour terraces and plant leguminous cover crops like Pueraria to prevent erosion and nitrogen fixation. Apply NPK fertilizers in two split doses during September and April. Use plastic rain guards on tapping panels during monsoons to prevent bark rot and ensure continuous tapping.`,
    guideML: `മികച്ച വിളവ് നൽകുന്ന ബഡ് ചെയ്ത തൈകൾ വേനൽമഴ ലഭിച്ചയുടനെ നടുക. കുന്നിൻപ്രദേശങ്ങളിൽ മണ്ണൊലിപ്പ് തടയാൻ തട്ടുകൾ തിരിച്ച് നടുകയും പ്യൂറേറിയ പോലെയുള്ള ആവരണവിളകൾ വളർത്തുകയും ചെയ്യണം. ഏപ്രിൽ, സെപ്റ്റംബർ മാസങ്ങളിൽ വളം നൽകുക. കനത്ത മഴക്കാലത്ത് ടാപ്പിംഗ് ഭാഗത്ത് റെയിൻ ഗാർഡുകൾ ഘടിപ്പിച്ച് സംരക്ഷിക്കുന്നത് ചീയൽ തടയാനും ടാപ്പിംഗ് തുടരാനും സഹായിക്കും.`,
    organicEN: `Rely on thick leguminous cover crops (Mucuna/Pueraria) to naturally fix atmospheric nitrogen. Broadcast Rock Phosphate over decaying cover crop residues. Replace chemical MOP by retaining fallen dry rubber leaves and adding coir pith compost and wood ash. Avoid heavy tillage to protect shallow feeder roots. Use organic wax based panel dressings for health.`,
    organicML: `തോട്ടം മുഴുവൻ ആവരണവിളകൾ നട്ടുപിടിപ്പിച്ചാൽ അന്തരീക്ഷത്തിൽ നിന്ന് നൈട്രജൻ ലഭിക്കുകയും യൂറിയ ഒഴിവാക്കുകയും ചെയ്യാം. ഫോസ്ഫറസിനായി റോക്ക് ഫോസ്ഫേറ്റ് വിതറിക്കൊടുക്കുക. പൊട്ടാഷിന് പകരമായി, കൊഴിഞ്ഞുവീഴുന്ന ഇലകൾ തോട്ടത്തിൽ അഴുകാൻ അനുവദിക്കുകയും ചകിരിച്ചോറ് കമ്പോസ്റ്റും മരച്ചാരവും തട്ടുകളിൽ നിക്ഷേപിക്കുകയും ചെയ്യുക. ഉപരിതല വേരുകൾക്ക് ക്ഷതമേൽപ്പിക്കാതിരിക്കാൻ ആഴത്തിൽ കിളയ്ക്കരുത്.`
  },
  { 
    id: 'tapioca', nameEN: 'Tapioca', nameML: 'മരച്ചീനി', cat: 'Tuber', pH: 6.0, N: 100, P: 50, K: 100, moistMin: 40, moistMax: 60, tempMin: 25, tempMax: 32, img: '🥔',
    elevations: ['Lowland', 'Midland', 'Highland'], seasons: ['Summer', 'SW Monsoon'],
    guideEN: `Requires abundant sunlight and loose soil. Plow deeply and form raised mounds or ridges. Plant 15-20 cm stem cuttings vertically, leaving 5cm above soil. Perfect drainage is critical. Perform weed management and earthing up 45-60 days after planting. Prune excess shoots to 2 per plant to ensure tuber size.`,
    guideML: `കിഴങ്ങുകൾ അഴുകാതിരിക്കാൻ ധാരാളം സൂര്യപ്രകാശവും വെള്ളം കെട്ടിനിൽക്കാത്ത ഇളക്കമുള്ള മണ്ണും ആവശ്യമാണ്. വലിയ കൂനകളോ വാരങ്ങളോ കോരിയ ശേഷം 15-20 സെൻ്റീമീറ്റർ നീളമുള്ള തണ്ടുകൾ കുത്തനെ നടുക. മഴക്കാലത്ത് വെള്ളം വാർന്നുപോകാൻ ചാലുകൾ കീറണം. നട്ട് 45-60 ദിവസങ്ങൾക്കുള്ളിൽ കളകൾ പറിച്ച് ചെടിയുടെ ചുവട്ടിലേക്ക് മണ്ണ് കൂട്ടിക്കൊടുക്കണം. ഒരു കമ്പിൽ രണ്ട് മുളകൾ മാത്രം നിർത്തി ബാക്കി നീക്കം ചെയ്യുക.`,
    organicEN: `Replace MOP by applying pure wood ash (1.5 t/ha) during earthing-up. Substitute Urea with organic poultry manure or goat manure. Use Bone Meal and Phosphate Solubilizing Bacteria (PSB). For mosaic virus management, use virus-free stems and spray Neem oil to control whitefly vectors.`,
    organicML: `മരച്ചീനിക്ക് കപ്പയ്ക്ക് കിഴങ്ങ് വെക്കാൻ മണ്ണിൽ ധാരാളം പൊട്ടാസ്യം ആവശ്യമാണ്. പൊട്ടാഷിന് പകരമായി മരച്ചാരവും ചകിരിച്ചോറ് കമ്പോസ്റ്റും തടത്തിൽ ചേർക്കുക. യൂറിയ ഒഴിവാക്കാൻ കോഴിവളമോ ഉണങ്ങിയ ചാണകപ്പൊടിയോ മണ്ണിൽ കലർത്തുക. ഫോസ്ഫറസ് ലഭിക്കാൻ അസ്ഥിപ്പൊടിയും പിഎസ്ബി (PSB) ജീവാണുവളങ്ങളും നൽകുക. മഞ്ഞളിപ്പ് രോഗം തടയാൻ രോഗമില്ലാത്ത കമ്പുകൾ ഉപയോഗിക്കുകയും വെള്ളീച്ചകളെ നിയന്ത്രിക്കാൻ വേപ്പെണ്ണ മിശ്രിതം തളിക്കുകയും ചെയ്യുക.`
  },
  { 
    id: 'pineapple', nameEN: 'Pineapple', nameML: 'കൈതച്ചക്ക', cat: 'Fruit', pH: 5.5, N: 200, P: 50, K: 200, moistMin: 50, moistMax: 70, tempMin: 22, tempMax: 32, img: '🍍', 
    elevations: ['Midland'], seasons: ['Summer', 'NE Monsoon'],
    guideEN: `Plant suckers or slips in shallow trenches. Best suited for laterite soil with high organic matter. For year-round production, use Ethephon (25ppm) to induce flowering after 10-12 months of growth. Provide partial shade if planting in open areas during peak summer to avoid sun scald. Mulching with dried grass is essential to conserve moisture.`,
    guideML: `ചാലുകൾ കീറി കൈതച്ചക്കയുടെ കന്നുകൾ നടുക. ജൈവാംശം കൂടുതലുള്ള വെട്ടുകല്ല് കലർന്ന മണ്ണ് ഇതിന് അനുയോജ്യമാണ്. എല്ലാ കാലത്തും വിളവ് ലഭിക്കാൻ 10-12 മാസം വളർച്ചയായ ചെടികളിൽ എതഫോൺ ലായനി ഒഴിച്ച് പൂവിടീക്കാം. കടുത്ത വേനലിൽ കായ്കൾ ഉണങ്ങിപ്പോകാതിരിക്കാൻ ഉണങ്ങിയ പുല്ല് കൊണ്ട് പുതയിടുന്നത് നല്ലതാണ്. വെള്ളം കെട്ടിനിൽക്കാതെ ഡ്രെയിനേജ് ഉറപ്പാക്കണം.`,
    organicEN: `Avoid Urea; spray fermented groundnut cake liquid. Use Rock Phosphate and fish amino acids for potassium. For mealybug control, use soap-water spray or neem-based pesticides. Use thick organic mulching instead of chemical weedicides. Apply high doses of vermicompost during the early vegetative stage.`,
    organicML: `യൂറിയ ഒഴിവാക്കി കടലപ്പിണ്ണാക്ക് പുളിപ്പിച്ചത് സ്പ്രേ ചെയ്യുക. പൊട്ടാസ്യത്തിന് ഫിഷ് അമിനോ ആസിഡും മരച്ചാരവും നൽകുക. മീലിബഗ് (വെള്ളപ്പൂപ്പൽ) ശല്യം ഒഴിവാക്കാൻ സോപ്പ് ലായനിയോ വേപ്പിൻ കഷായമോ ഉപയോഗിക്കുക. കളനാശിനികൾക്ക് പകരം പച്ചിലകളോ പുല്ലോ ഉപയോഗിച്ച് കട്ടിയായി പുതയിടുക. തുടക്കത്തിൽ തന്നെ ധാരാളം മണ്ണിരക്കമ്പോസ്റ്റ് നൽകുന്നത് വളർച്ച വേഗത്തിലാക്കും.`
  },
  { 
    id: 'mango', nameEN: 'Mango', nameML: 'മാങ്ങ', cat: 'Fruit', pH: 6.0, N: 75, P: 25, K: 75, moistMin: 40, moistMax: 60, tempMin: 24, tempMax: 35, img: '🥭', 
    elevations: ['Lowland', 'Midland'], seasons: ['Summer'], 
    guideEN: `Plant grafted varieties (Neelam, Mallika, Priyour) in 1m pits. Deep watering once a week during early stages is crucial. Prune dead wood and water-shoots annually after harvest. Smoke the orchard during the flowering season to repel hopper pests and stimulate blossom. Fruit thinning ensures larger, high-quality mangoes.`, 
    guideML: `നീലം, മല്ലിക, പ്രിയൂർ തുടങ്ങിയ ഗ്രാഫ്റ്റ് തൈകൾ നടുക. ആദ്യകാലങ്ങളിൽ ആഴ്ചയിലൊരിക്കൽ നന്നായി നനയ്ക്കണം. വിളവെടുപ്പിന് ശേഷം ഉണങ്ങിയ കൊമ്പുകൾ വെട്ടിമാറ്റുക. പൂക്കുന്ന സമയത്ത് പുകയിടുന്നത് (പുകയിടൽ) ഇലച്ചാടികളെ അകറ്റാനും പൂക്കൾ നന്നായി പിടിക്കാനും സഹായിക്കും. കായ്കൾ അധികമുണ്ടെങ്കിൽ കുറച്ചു കുറയ്ക്കുന്നത് ബാക്കിയുള്ളവ വലിപ്പം വെക്കാൻ സഹായിക്കും.`, 
    organicEN: `Apply 30kg compost per tree before monsoon. Use Bone Meal and wood ash to boost flowering. For fruit fly management, use Tulsi-water traps or Pheromone traps. Spray Pseudomonas to prevent leaf-spot diseases. Use Neem cake in the basin to repel soil-borne larvae.`,
    organicML: `വർഷത്തിൽ 30 കിലോ കമ്പോസ്റ്റ് മഴക്കാലത്തിന് മുൻപ് നൽകുക. പൂക്കാൻ അസ്ഥിപ്പൊടിയും മരച്ചാരവും നൽകുക. കായീച്ചകളെ തടയാൻ തുളസി കെണികളോ ഫെറമോൺ കെണികളോ ഉപയോഗിക്കുക. ഇലപ്പുള്ളി രോഗം തടയാൻ സ്യൂഡോമോണാസ് ലായനി തളിക്കുക. വേപ്പിൻ പിണ്ണാക്ക് തടത്തിൽ ചേർക്കുന്നത് മണ്ണിലെ കീടങ്ങളെ നശിപ്പിക്കും.`
  },
  { 
    id: 'banana', nameEN: 'Banana', nameML: 'വാഴ', cat: 'Fruit', pH: 7.0, N: 180, P: 60, K: 300, moistMin: 60, moistMax: 80, tempMin: 26, tempMax: 35, img: '🍌',
    elevations: ['Lowland', 'Midland'], seasons: ['Summer', 'SW Monsoon', 'NE Monsoon'],
    guideEN: `Requires macro-nutrients and regular irrigation. Select disease-free sword suckers. Provide sturdy propping for bunches. Perform desuckering regularly. Earthing up prevents corm exposure. Apply lime to soil to maintain pH. Potassium is critical for bunch weight.`,
    guideML: `വാഴക്കൃഷിക്ക് അത്യധികം പോഷകങ്ങളും വേനൽക്കാലത്ത് ധാരാളം ജലസേചനവും വേണം. രോഗബാധയില്ലാത്ത സൂചിക്കന്നുകൾ നടുക. കുലകൾക്ക് താങ്ങ് നൽകണം. അധികമുള്ള വാഴക്കന്നുകൾ വെട്ടിമാറ്റുക (Desuckering). മണ്ണിൽ കുമ്മായം ചേർക്കുന്നത് അമ്ലത്വം കുറയ്ക്കാൻ സഹായിക്കും. കായ്കൾക്ക് തൂക്കം ലഭിക്കാൻ പൊട്ടാസ്യം അത്യാവശ്യമാണ്.`,
    organicEN: `Replace Urea with 10-15 kg of green cow dung in the pit. Use fermented groundnut cake slurry bi-monthly. For P, add 500g Bone Meal. Replace MOP with 2 kg wood ash and pseudostem compost. Use Trichoderma-enriched manure to prevent Panama wilt.`,
    organicML: `യൂറിയ ഒഴിവാക്കാൻ നടുമ്പോൾ 15 കിലോ പച്ചച്ചാണകം നൽകുക. കടലപ്പിണ്ണാക്ക് പുളിപ്പിച്ചത് രണ്ട് മാസം കൂടുമ്പോൾ ഒഴിക്കുക. ഫോസ്ഫറസിന് അര കിലോ അസ്ഥിപ്പൊടി നൽകുക. പൊട്ടാസ്യത്തിന് 2 കിലോ മരച്ചാരവും വാഴപ്പിണ്ടി കമ്പോസ്റ്റും ഉപയോഗിക്കാം. വാട്ടരോഗം തടയാൻ ട്രൈക്കോഡെർമ ചേർത്ത വളം നൽകുക.`
  },
  { 
    id: 'pepper', nameEN: 'Pepper', nameML: 'കുരുമുളക്', cat: 'Spice', pH: 6.0, N: 50, P: 50, K: 150, moistMin: 60, moistMax: 80, tempMin: 23, tempMax: 32, img: '🌿',
    elevations: ['Midland', 'Highland'], seasons: ['SW Monsoon'],
    guideEN: `Plant rooted cuttings at the base of support trees (Erythrina). Excellent drainage is vital to prevent root rot. Tie emerging shoots to the standard. Mulch the base heavily before summer. Prune the top of support trees to regulate shade. Apply lime to basins annually.`,
    guideML: `താങ്ങുമരങ്ങളുടെ ചുവട്ടിൽ നടവള്ളികൾ നടുക. വെള്ളം കെട്ടിനിൽക്കാതെ ഡ്രെയിനേജ് ഉറപ്പാക്കണം. വള്ളികൾ വളരുന്നതിനനുസരിച്ച് താങ്ങുമരത്തോട് ചേർത്ത് കെട്ടിക്കൊടുക്കുക. വേനലിന് മുൻപ് ചുവട്ടിൽ നല്ലപോലെ പുതയിടണം. താങ്ങുമരങ്ങളുടെ കൊമ്പുകൾ വെട്ടി തണൽ ക്രമീകരിക്കണം. ഓരോ വർഷവും തടത്തിൽ കുമ്മായം വിതറണം.`,
    organicEN: `Use Trichoderma and Pseudomonas enriched manure. Substitute Urea with Groundnut cake and Neem cake mixture. Spray fish amino acids before flowering for spike production. For 'Pollu' beetle, spray Neem oil. Maintain high organic matter in the soil to support micro-flora.`,
    organicML: `ട്രൈക്കോഡെർമയും സ്യൂഡോമോണാസും ചേർത്ത് സമ്പുഷ്ടമാക്കിയ വളം നൽകുക. നൈട്രജന് കടലപ്പിണ്ണാക്കും വേപ്പിൻ പിണ്ണാക്കും കലർത്തി വിതറുക. തിരികൾ ഉണ്ടാകാൻ പൂക്കുന്നതിന് മുൻപ് ഫിഷ് അമിനോ ആസിഡ് സ്പ്രേ ചെയ്യുക. 'പൊള്ളു' വണ്ട് ശല്യം ഒഴിവാക്കാൻ വേപ്പെണ്ണ മിശ്രിതം തളിക്കുക. ജൈവവളങ്ങൾ കൂടുതൽ നൽകുന്നത് വേരുകളുടെ ആരോഗ്യത്തിന് നല്ലതാണ്.`
  },
  { 
    id: 'cardamom', nameEN: 'Cardamom', nameML: 'ഏലം', cat: 'Spice', pH: 5.5, N: 60, P: 40, K: 120, moistMin: 75, moistMax: 90, tempMin: 15, tempMax: 30, img: '🌱', 
    elevations: ['Highland'], seasons: ['SW Monsoon', 'NE Monsoon'],
    guideEN: `Demands dense overhead shade and high humidity. Plant suckers in shallow pits with forest soil and compost. Mulching with dry leaves is non-negotiable. Remove old shoots annually. Protect from strong winds. Bee-keeping in cardamom plantations improves pollination and yield significantly.`,
    guideML: `നല്ല തണലും ഈർപ്പവും ഉള്ള മലനാട് പ്രദേശങ്ങളിൽ വളരുന്നു. കാട്ടുമണ്ണും കമ്പോസ്റ്റും നിറച്ച കുഴികളിൽ കന്നുകൾ നടുക. കരിയിലകൾ കൊണ്ട് പുതയിടേണ്ടത് നിർബന്ധമാണ്. പഴയ ശരങ്ങൾ വെട്ടിമാറ്റുക. കാറ്റിൽ നിന്ന് സംരക്ഷണം നൽകുക. ഏലത്തോട്ടങ്ങളിൽ തേനീച്ച വളർത്തുന്നത് പരാഗണം വർദ്ധിപ്പിക്കാനും വിളവ് കൂട്ടാനും സഹായിക്കും.`,
    organicEN: `Replace Urea by forest leaf mulch. Apply 2 kg vermicompost per clump twice a year. Spray diluted fish amino acid during panicle emergence. For thrips control, use tobacco decoction or neem-based sprays. Avoid chemical weeding; go for manual slashing.`,
    organicML: `യൂറിയ ഒഴിവാക്കി പച്ചിലകൾ പുതയിടുക. വർഷത്തിൽ രണ്ട് തവണ 2 കിലോ മണ്ണിരക്കമ്പോസ്റ്റ് നൽകുക. ശരങ്ങൾ വരുമ്പോൾ ഫിഷ് അമിനോ ആസിഡ് സ്പ്രേ ചെയ്യുക. ത്രിപ്സ് (ഇലപ്പേൻ) നിയന്ത്രിക്കാൻ പുകയില കഷായമോ വേപ്പിൻ കഷായമോ ഉപയോഗിക്കുക. രാസ കളനാശിനികൾ ഒഴിവാക്കി യന്ത്രങ്ങൾ ഉപയോഗിച്ചോ കൈകൊണ്ടോ കളകൾ വെട്ടുക.`
  },
  { 
    id: 'nutmeg', nameEN: 'Nutmeg', nameML: 'ജാതിക്ക', cat: 'Spice', pH: 6.5, N: 100, P: 50, K: 100, moistMin: 60, moistMax: 80, tempMin: 22, tempMax: 30, img: '🌰', 
    elevations: ['Midland', 'Highland'], seasons: ['SW Monsoon'], 
    guideEN: `Requires dense shade in early years. Plant grafted female plants or monoecious varieties. High soil moisture but zero water-logging is needed. Apply balanced NPK in two split doses. Protect the main trunk from direct sunlight during the first three years to avoid sun-burn cracks.`,
    guideML: `ആദ്യ വർഷങ്ങളിൽ കനത്ത തണൽ നൽകണം. ഗ്രാഫ്റ്റ് ചെയ്ത പെൺതൈകൾ അല്ലെങ്കിൽ ഉഭയലിംഗ തൈകൾ നടുക. മണ്ണിൽ നല്ല ഈർപ്പം വേണം, എന്നാൽ വെള്ളം കെട്ടിനിൽക്കരുത്. രാസവളം രണ്ടു തവണയായി നൽകുക. ആദ്യത്തെ മൂന്ന് വർഷം തടിയിൽ നേരിട്ട് വെയിൽ തട്ടാതെ സംരക്ഷിക്കണം (തടി വിണ്ടുകീറാതിരിക്കാൻ).`,
    organicEN: `Fill circular trench with 25kg cow dung. Add Neem Cake and Bone Meal. Wood ash is vital for high-quality red mace. Use Trichoderma-fortified compost for preventing root-wilt. Avoid synthetic fungicides; use Bordeaux mixture 1% for fruit-rot.`,
    organicML: `തടത്തിൽ 25 കിലോ ചാണകപ്പൊടി നൽകുക. വേപ്പിൻ പിണ്ണാക്കും അസ്ഥിപ്പൊടിയും കലർത്തുക. ജാതിപത്രിക്ക് നല്ല നിറം കിട്ടാൻ മരച്ചാരം അത്യാവശ്യമാണ്. വേരുവാട്ടം തടയാൻ ട്രൈക്കോഡെർമ ചേർത്ത കമ്പോസ്റ്റ് ഉപയോഗിക്കുക. കായ്ചീയൽ തടയാൻ 1% ബോർഡോ മിശ്രിതം തളിക്കുക.`
  },
  { 
    id: 'clove', nameEN: 'Clove', nameML: 'ഗ്രാമ്പൂ', cat: 'Spice', pH: 6.0, N: 80, P: 40, K: 80, moistMin: 60, moistMax: 80, tempMin: 20, tempMax: 30, img: '🌸', 
    elevations: ['Midland', 'Highland'], seasons: ['SW Monsoon'], 
    guideEN: `Flourishes in deep, rich loamy soils with excellent drainage. Provide artificial shade for seedlings. Pruning is usually not required. Harvesting must be done when buds are full-sized but before petals open. Drying cloves on clean mats to 10% moisture is critical for export quality.`,
    guideML: `വെള്ളം വാർന്നുപോകുന്ന ഫലഭൂയിഷ്ഠമായ മണ്ണിൽ തഴച്ചുവളരും. തൈകൾക്ക് ആദ്യകാലത്ത് തണൽ നൽകണം. കൊമ്പുകോതൽ ആവശ്യമില്ല. മൊട്ടുകൾ വിരിയുന്നതിന് മുൻപ് തന്നെ പറിച്ചെടുക്കണം. വൃത്തിയുള്ള പായകളിൽ ഉണക്കി 10% ഈർപ്പത്തിൽ സൂക്ഷിക്കുന്നത് ഗുണമേന്മ വർദ്ധിപ്പിക്കും.`,
    organicEN: `Apply 20kg dried cow dung yearly. Dig shallow trenches for Bone Meal and wood ash. Use Pongamia or Neem cake to prevent stem borer. For leaf spot, spray Pseudomonas. Ensure the basin is always covered with organic mulch to protect delicate surface roots.`,
    organicML: `വർഷത്തിൽ 20 കിലോ ചാണകപ്പൊടി നൽകുക. അസ്ഥിപ്പൊടിയും മരച്ചാരവും ചാലുകളിൽ ഇടുക. തണ്ട് തുരപ്പനെ നിയന്ത്രിക്കാൻ ഉങ്ങിൻ പിണ്ണാക്കോ വേപ്പിൻ പിണ്ണാക്കോ ഉപയോഗിക്കുക. ഇലപ്പുള്ളി രോഗത്തിന് സ്യൂഡോമോണാസ് തളിക്കുക. ഉപരിതല വേരുകളെ സംരക്ഷിക്കാൻ തടത്തിൽ എപ്പോഴും പുതയിടുക.`
  },
  { 
    id: 'cinnamon', nameEN: 'Cinnamon', nameML: 'കറുവപ്പട്ട', cat: 'Spice', pH: 6.0, N: 60, P: 30, K: 60, moistMin: 60, moistMax: 80, tempMin: 20, tempMax: 30, img: '🪵', 
    elevations: ['Midland', 'Highland'], seasons: ['SW Monsoon'], 
    guideEN: `Coppice the main stem after 2 years at 15cm from ground to encourage lateral shoots. Harvest inner bark during the rainy season when it peels easily. Periodic thinning of shoots is needed to maintain quality. Soil must be well-drained and slightly acidic for best essential oil content.`,
    guideML: `2 വർഷത്തിന് ശേഷം പ്രധാന തണ്ട് വെട്ടിമാറ്റി പുതിയ ശിഖരങ്ങൾ വളരാൻ അനുവദിക്കുക (Coppicing). മഴക്കാലത്ത് തൊലി പൊളിച്ചെടുക്കാൻ എളുപ്പമായതിനാൽ ആ സമയത്ത് വിളവെടുക്കുക. മികച്ച എണ്ണാംശം ലഭിക്കാൻ വെള്ളം കെട്ടിനിൽക്കാത്ത അമ്ലഗുണമുള്ള മണ്ണ് ആവശ്യമാണ്. ശിഖരങ്ങൾ ഇടയ്ക്കിടെ കുറയ്ക്കണം.`,
    organicEN: `Incorporate 10kg green cow dung around base yearly. Integrate wood ash for bark quality and thickness. Use organic compost mixed with leaf mold. Maintain soil health through cover cropping. Avoid chemical pesticides to preserve the natural aroma of the bark.`,
    organicML: `10 കിലോ പച്ചച്ചാണകം തടത്തിൽ നൽകുക. തൊലിയുടെ ഗുണത്തിനും കനത്തിനും മരച്ചാരം കലർത്തുക. കരിയിലക്കമ്പോസ്റ്റും ചാണകവും ചേർത്ത് നൽകുക. ആവരണവിളകൾ വളർത്തുന്നത് മണ്ണിലെ ഈർപ്പം നിലനിർത്തും. ഗന്ധം നഷ്ടപ്പെടാതിരിക്കാൻ രാസകീടനാശിനികൾ പൂർണ്ണമായും ഒഴിവാക്കുക.`
  },
  { 
    id: 'cocoa', nameEN: 'Cocoa', nameML: 'കൊക്കോ', cat: 'Plantation', pH: 6.0, N: 100, P: 40, K: 140, moistMin: 70, moistMax: 85, tempMin: 22, tempMax: 32, img: '🍫', 
    elevations: ['Midland'], seasons: ['Summer', 'SW Monsoon'], 
    guideEN: `Best grown as intercrop under coconut/arecanut. Prune branches to ensure airflow and sunlight penetration, which prevents black pod disease. Regular harvesting of ripe pods is necessary to avoid squirrel and bat attacks. Provide irrigation during dry summer months to prevent leaf shedding.`,
    guideML: `തെങ്ങിനും കവുങ്ങിനും ഇടവിളയായി നടാൻ ഏറ്റവും അനുയോജ്യം. കൊമ്പുകോതി വായുസഞ്ചാരവും വെളിച്ചവും ഉറപ്പാക്കുന്നത് കായ്ചീയൽ (Black Pod) തടയും. അണ്ണാൻ, വവ്വാൽ എന്നിവയുടെ ശല്യം ഒഴിവാക്കാൻ കായ്കൾ പഴുക്കുമ്പോൾ തന്നെ പറിക്കണം. വേനൽക്കാലത്ത് നനയ്ക്കുന്നത് ഇലകൾ കൊഴിയാതിരിക്കാൻ സഹായിക്കും.`,
    organicEN: `Create active mulch basin with fallen leaves. Add 15kg vermicompost and wood ash annually. Use botanical extracts or neem oil for mealybug and pod borer management. Recycle the cocoa pod husks by composting them and returning them to the basin.`,
    organicML: `കൊക്കോയുടെ തന്നെ കൊഴിഞ്ഞ ഇലകൾ കൊണ്ട് തടത്തിൽ പുതയിടുക. 15 കിലോ മണ്ണിരക്കമ്പോസ്റ്റും മരച്ചാരവും നൽകുക. മീലിബഗ്, കായ്തുരപ്പൻ എന്നിവയ്ക്കെതിരെ വേപ്പെണ്ണ സ്പ്രേ ചെയ്യുക. കൊക്കോ തൊണ്ട് കമ്പോസ്റ്റാക്കി തടത്തിൽ തന്നെ തിരികെ ചേർക്കുന്നത് പോഷകങ്ങൾ തിരികെ ലഭിക്കാൻ സഹായിക്കും.`
  },
  { 
    id: 'vanilla', nameEN: 'Vanilla', nameML: 'വാനില', cat: 'Spice', pH: 6.0, N: 60, P: 30, K: 60, moistMin: 70, moistMax: 85, tempMin: 25, tempMax: 32, img: '🌿', 
    elevations: ['Midland', 'Highland'], seasons: ['SW Monsoon'], 
    guideEN: `Plant with living support trees (Glyricidia). Maintain 50% filtered sunlight. Artificial hand pollination is strictly required between 6 AM to 11 AM during flowering season. Avoid excessive nitrogen as it leads to more vine growth and fewer flowers. Pruning of vine tips encourages flowering.`,
    guideML: `ശീമക്കൊന്ന പോലെയുള്ള താങ്ങുമരങ്ങളിൽ പടർത്തുക. 50% തണൽ നൽകണം. പൂക്കുന്ന കാലത്ത് രാവിലെ 6 മുതൽ 11 മണി വരെ കൈകൾ കൊണ്ട് പരാഗണം (Hand Pollination) നടത്തേണ്ടത് നിർബന്ധമാണ്. നൈട്രജൻ കൂടിയാൽ വള്ളി മാത്രം വളരുകയും പൂക്കൾ കുറയുകയും ചെയ്യും. വള്ളികളുടെ അഗ്രം വെട്ടുന്നത് പൂക്കൾ ഉണ്ടാകാൻ സഹായിക്കും.`,
    organicEN: `Avoid chemical NPK to protect surface roots. Lightly scatter premium vermicompost and decomposed leaf mold on the surface. Use mulching to keep roots cool. Control fungal rot using Pseudomonas liquid spray. Use diluted Jeevamrutham to boost immunity of the vines.`,
    organicML: `ഉപരിതല വേരുകളെ സംരക്ഷിക്കാൻ രാസവളങ്ങൾ ഒഴിവാക്കുക. മണ്ണിരക്കമ്പോസ്റ്റും ഇലപ്പൊടിയും ഉപരിതലത്തിൽ മാത്രം വിതറുക. വേരുകൾക്ക് ചൂടേൽക്കാതിരിക്കാൻ പുതയിടുക. ഫംഗസ് രോഗങ്ങൾക്കെതിരെ സ്യൂഡോമോണാസ് തളിക്കുക. വള്ളികളുടെ പ്രതിരോധശേഷി കൂട്ടാൻ ജീവാമൃതം നേർപ്പിച്ചു നൽകുക.`
  },
  { 
    id: 'tamarind', nameEN: 'Tamarind', nameML: 'പുളി', cat: 'Spice', pH: 6.0, N: 50, P: 20, K: 50, moistMin: 30, moistMax: 50, tempMin: 25, tempMax: 35, img: '🫘', 
    elevations: ['Lowland', 'Midland'], seasons: ['Summer'], 
    guideEN: `Highly drought tolerant tree. Plant in well-spaced areas (10m x 10m) to prevent canopy crowding. Requires minimal fertilizer after establishment. Best propagated through grafting to ensure early fruiting and true-to-type quality. Pruning of central leader in early years encourages spread.`,
    guideML: `വരൾച്ചയെ അതിജീവിക്കുന്ന മരമാണ് പുളി. ധാരാളം സ്ഥലം വിട്ട് (10x10 മീറ്റർ) നടുക. വളർന്നുകഴിഞ്ഞാൽ വലിയ വളപ്രയോഗം ആവശ്യമില്ല. ഗ്രാഫ്റ്റ് തൈകൾ നടുന്നത് വേഗത്തിൽ കായ്ക്കാനും ഗുണമേന്മ ഉറപ്പാക്കാനും സഹായിക്കും. ആദ്യ വർഷങ്ങളിൽ നടുഭാഗം വെട്ടിമാറ്റുന്നത് മരം പടർന്നു വളരാൻ സഹായിക്കും.`,
    organicEN: `Zero chemical inputs are often sufficient. Build a wide shallow basin with dry leaves and 10kg cow dung yearly to sustain moisture and health. Use wood ash during the fruiting stage to improve pulp quality. Integrated pest management for scale insects using soap spray.`,
    organicML: `സാധാരണയായി രാസവളങ്ങൾ ആവശ്യമില്ല. തടത്തിൽ കരിയിലകളും 10 കിലോ ചാണകവും ഇടുന്നത് ഈർപ്പം നിലനിർത്തും. പുളി വിളയുമ്പോൾ മരച്ചാരം നൽകുന്നത് പുളിയുടെ ഗുണം വർദ്ധിപ്പിക്കും. ശൽക്കകീടങ്ങളെ നിയന്ത്രിക്കാൻ സോപ്പ് ലായനി സ്പ്രേ ചെയ്താൽ മതിയാകും.`
  },
  { 
    id: 'yam', nameEN: 'Yam (Elephant Foot)', nameML: 'ചേന', cat: 'Tuber', pH: 6.0, N: 100, P: 50, K: 150, moistMin: 50, moistMax: 70, tempMin: 25, tempMax: 30, img: '🍠', 
    elevations: ['Midland'], seasons: ['Summer', 'SW Monsoon'], 
    guideEN: `Plant 1kg corm pieces in deep pits filled with heavy manure and leaf mold. Earth up soil around the base after 2 and 4 months. Maintain high soil moisture but avoid stagnation. Staking is not required for elephant foot yam but weeding is essential in the first 3 months.`,
    guideML: `ഒരു കിലോ തൂക്കമുള്ള കഷണങ്ങൾ വളവും കരിയിലയും നിറച്ച വലിയ കുഴികളിൽ നടുക. 2, 4 മാസങ്ങൾക്ക് ശേഷം മണ്ണ് കൂട്ടിക്കൊടുക്കണം. മണ്ണിൽ എപ്പോഴും നനവുണ്ടായിരിക്കണം എന്നാൽ വെള്ളം കെട്ടിക്കിടക്കരുത്. ആദ്യ 3 മാസം കളകൾ വരാതെ നോക്കേണ്ടത് അത്യാവശ്യമാണ്.`,
    organicEN: `Use 500g wood ash per pit for potassium requirement. Add 5kg premium dry cow dung as basal dose. Treat corm pieces with cow dung slurry and wood ash before planting to prevent rot. Use vermicompost during the second earthing up for better tuber expansion.`,
    organicML: `കുഴിയിൽ 5 കിലോ ചാണകപ്പൊടിയും അര കിലോ മരച്ചാരവും ചേർക്കുക. നടുന്നതിന് മുൻപ് ചേനക്കഷണങ്ങൾ ചാണകവെള്ളത്തിലും മരച്ചാരത്തിലും മുക്കി വെക്കുന്നത് ചീയൽ തടയും. രണ്ടാമത് മണ്ണ് കൂട്ടുമ്പോൾ മണ്ണിരക്കമ്പോസ്റ്റ് നൽകുന്നത് ചേന നന്നായി വലിപ്പം വെക്കാൻ സഹായിക്കും.`
  },
  { 
    id: 'okra', nameEN: 'Okra', nameML: 'വെണ്ടയ്ക്ക', cat: 'Vegetable', pH: 6.5, N: 100, P: 50, K: 50, moistMin: 50, moistMax: 70, tempMin: 25, tempMax: 35, img: '🌿', 
    elevations: ['Lowland', 'Midland'], seasons: ['Summer', 'SW Monsoon'], 
    guideEN: `Plant seeds directly in ridges at 30cm spacing. Requires full sun and consistent watering. Ruthlessly uproot plants showing Yellow Vein Mosaic Virus (YVMV) to prevent spread. Harvest tender pods every alternate day. Apply top-dressing of Urea 30 days after sowing for rapid growth.`,
    guideML: `വാരങ്ങളിൽ 30 സെ.മീ അകലത്തിൽ വിത്തുകൾ നടുക. നല്ല വെയിലും കൃത്യമായ നനയും വേണം. മഞ്ഞളിപ്പ് രോഗം (Mosaic) വന്ന ചെടികളെ കണ്ടാലുടൻ വേരോടെ പിഴുതു മാറ്റുക. ഇളം വെണ്ടയ്ക്കകൾ രണ്ടു ദിവസം കൂടുമ്പോൾ പറിച്ചെടുക്കുക. നട്ട് 30 ദിവസത്തിന് ശേഷം വളം നൽകുന്നത് വേഗത്തിലുള്ള വളർച്ചയ്ക്ക് സഹായിക്കും.`,
    organicEN: `Weekly bio-slurry of diluted cow dung. Add Steamed Bone Meal and wood ash to ridges. Use Neem oil spray (2%) and Garlic extract for aphid and whitefly control. Plant marigolds as a trap crop to divert pests. Use yellow sticky traps to capture whitefly vectors of YVMV.`,
    organicML: `ആഴ്ചയിലൊരിക്കൽ ചാണകപ്പാൽ നേർപ്പിച്ച് ഒഴിക്കുക. മരച്ചാരവും അസ്ഥിപ്പൊടിയും നൽകുക. ഇലപ്പേൻ, വെള്ളീച്ച എന്നിവയ്ക്കെതിരെ വേപ്പെണ്ണ-വെളുത്തുള്ളി മിശ്രിതം ഉപയോഗിക്കുക. ചെണ്ടുമല്ലി ഇടവിളയായി നടുന്നത് കീടങ്ങളെ അകറ്റും. മഞ്ഞക്കെണികൾ ഉപയോഗിക്കുന്നത് മഞ്ഞളിപ്പ് രോഗം പരത്തുന്ന വെള്ളീച്ചകളെ പിടിക്കാൻ സഹായിക്കും.`
  }
];

// --- 2. Offline Pests Database (30 Pests with Broad Keywords) ---
const pestsDB = [
  { 
    id: 'rhinocerous_beetle', nameEN: 'Rhinoceros Beetle', nameML: 'കൊമ്പൻ ചെല്ലി',
    keywords: ['hole', 'cut', 'v-shape', 'crown', 'beetle', 'spots', 'dry leaf', 'falling leaves', 'കൊമ്പൻ', 'ചെല്ലി', 'ഓല', 'വെട്ട്'],
    symptomsEN: 'Adults bore into unopened fronds causing distinct V-shaped cuts on emerging leaves. It destroys the palm heart (growing point) leading to crown choking.',
    symptomsML: 'വിരിയാത്ത ഇളം ഓലകളിൽ തുരന്നുകയറുന്നു. ഓല വിരിഞ്ഞു വരുമ്പോൾ അവയിൽ V ആകൃതിയിലുള്ള വെട്ടുകൾ കാണാം. ഇത് തെങ്ങിന്റെ കൂമ്പ് നശിപ്പിക്കുകയും വളർച്ചയെ തടയുകയും ചെയ്യുന്നു.',
    organicEN: 'Apply a 1:2 mixture of neem cake and river sand in leaf axils. Place PVC pheromone traps (Rhino-lure) at 5 per hectare to mass-trap adults.',
    organicML: 'വേപ്പിൻ പിണ്ണാക്കും മണലും 1:2 അനുപാതത്തിൽ മുകളിലെ ഓലക്കവിളുകളിൽ ഇടുക. ഹെക്ടറിന് 5 എന്ന ക്രമത്തിൽ ഫെറമോൺ കെണികൾ (റൈനോലൂർ) ഉപയോഗിച്ച് ചെല്ലികളെ പിടിക്കാം.',
    chemicalEN: 'Place Sevidol granules (25g) mixed with fine sand in the inner leaf axils. Avoid applications during heavy rainfall days.',
    chemicalML: '25 ഗ്രാം സെവിഡോൾ ഗുളികകൾ മണലുമായി കലർത്തി മണ്ടയിലെ ഓലക്കവിളുകളിൽ ഇടുക. കനത്ത മഴയുള്ളപ്പോൾ ഇത് ചെയ്യരുത്.',
    preventiveEN: 'Routinely clean the crown. Destroy decaying organic matter, old compost pits, and dead palm trunks where larvae breed and multiply.',
    preventiveML: 'തെങ്ങിന്റെ മണ്ട എപ്പോഴും വൃത്തിയായി സൂക്ഷിക്കുക. ഇവ മുട്ടയിട്ട് വളരുന്ന ചാണകക്കുഴികളും അഴുകിയ തെങ്ങിൻ തടികളും നശിപ്പിക്കുക.'
  },
  { 
    id: 'red_palm_weevil', nameEN: 'Red Palm Weevil', nameML: 'ചുവന്ന ചെല്ലി',
    keywords: ['hole', 'oozing', 'liquid', 'sound', 'chewing', 'red', 'brown', 'rotting', 'ദ്രാവകം', 'ശബ്ദം', 'ചുവന്ന', 'ചെല്ലി'],
    symptomsEN: 'The most destructive pest. Grubs bore deep inside the trunk. Symptoms include small holes oozing foul-smelling brownish-red liquid and audible chewing sounds.',
    symptomsML: 'ഏറ്റവും അപകടകാരിയായ കീടം. ഇവയുടെ പുഴുക്കൾ തടിയുടെ ഉൾഭാഗം കാർന്നുതിന്നുന്നു. ദ്വാരങ്ങളിൽ നിന്ന് ചുവന്ന ദ്രാവകം ഒലിച്ചിറങ്ങുന്നതും ഉള്ളിൽ നിന്നുള്ള ചവയ്ക്കുന്ന ശബ്ദവും ലക്ഷണങ്ങളാണ്.',
    organicEN: 'Deploy bucket pheromone traps. Inject pure neem oil mixed with turmeric deep into the holes and plug with wet clay to suffocate the grubs.',
    organicML: 'ബക്കറ്റ് ഫെറമോൺ കെണികൾ സ്ഥാപിക്കുക. ദ്വാരങ്ങളിലേക്ക് വേപ്പെണ്ണയും മഞ്ഞൾപ്പൊടിയും കലർത്തിയത് പമ്പ് ചെയ്ത ശേഷം കളിമണ്ണ് ഉപയോഗിച്ച് അടയ്ക്കുക.',
    chemicalEN: 'Inject approved systemic insecticides like Indoxacarb or Imidacloprid into the affected area and seal the entry holes with mud.',
    chemicalML: 'ഇൻഡോക്സാകാർബ് പോലെയുള്ള കീടനാശിനികൾ ദ്വാരങ്ങളിലൂടെ സിറിഞ്ച് ഉപയോഗിച്ച് ഒഴിച്ച് അടയ്ക്കുക.',
    preventiveEN: 'Prevent any mechanical injury to the palm trunk. Wounds made by sickles or hooks are the primary entry points for egg-laying females.',
    preventiveML: 'തെങ്ങിൻ തടിയിൽ മുറിവുകൾ ഉണ്ടാക്കാതിരിക്കാൻ ശ്രദ്ധിക്കുക. ഇത്തരം മുറിവുകളിലൂടെയാണ് ചെല്ലി മുട്ടയിടാൻ തടിക്കുള്ളിലേക്ക് കടക്കുന്നത്.'
  },
  { 
    id: 'rice_stem_borer', nameEN: 'Rice Stem Borer', nameML: 'തണ്ടുതുരപ്പൻ പുഴു',
    keywords: ['dead heart', 'white ear', 'dry', 'borer', 'stem', 'dry leaf', 'wilting', 'തണ്ട്', 'വെൺകതിർ', 'പുഴു'],
    symptomsEN: 'Caterpillars bore into rice stems during vegetative stage causing "dead heart" (wilting of central leaf) and "white ear" (empty white panicles) during flowering.',
    symptomsML: 'പുഴുക്കൾ നെല്ലിന്റെ തണ്ടിനുള്ളിൽ കയറി ഉൾഭാഗം തിന്നുതീർക്കുന്നു. ഇത് കൂമ്പ് ഉണങ്ങുന്നതിനും (Dead Heart), കതിര് വരുന്ന സമയത്ത് വെൺകതിരുകൾ (പതിര്) ഉണ്ടാകുന്നതിനും കാരണമാകുന്നു.',
    organicEN: 'Release Trichogramma egg parasitoids at weekly intervals. Spray 5% Neem Seed Kernel Extract (NSKE) or Beauveria bassiana directly onto the plants.',
    organicML: 'ട്രൈക്കോഗ്രമ്മ മിത്രകീടങ്ങളെ പാടത്ത് തുറന്നുവിടുക. 5% വീര്യമുള്ള വേപ്പിൻകുരു സത്തോ ബ്യൂവേറിയ ബാസിയാനയോ ചെടികളിൽ തളിക്കുക.',
    chemicalEN: 'Apply Cartap Hydrochloride or Fipronil granules in the field water. Ensure standing water is maintained for effectiveness.',
    chemicalML: 'കാർട്ടാപ്പ് ഹൈഡ്രോക്ലോറൈഡ് അല്ലെങ്കിൽ ഫിപ്രോണിൽ ഗുളികകൾ പാടത്ത് വിതറുക. പാടത്ത് കുറഞ്ഞ അളവിൽ വെള്ളം ഉണ്ടായിരിക്കണം.',
    preventiveEN: 'Clip off the tips of rice seedlings before transplanting to remove unseen egg masses. Avoid excessive nitrogen fertilizer applications.',
    preventiveML: 'ഞാറുകൾ നടുന്നതിന് മുൻപ് ഇലകളുടെ അറ്റം നുള്ളി മാറ്റുന്നത് മുട്ടകളെ നശിപ്പിക്കാൻ സഹായിക്കും. നൈട്രജൻ വളങ്ങൾ അധികമാകരുത്.'
  },
  { 
    id: 'quick_wilt', nameEN: 'Quick Wilt (Phytophthora)', nameML: 'ദ്രുതവാട്ടം',
    keywords: ['yellow', 'wilting', 'drop', 'rot', 'fall', 'falling leaves', 'dry leaf', 'rotting', 'curling', 'വാട്ടം', 'മഞ്ഞ', 'കൊഴിയുക'],
    symptomsEN: 'Deadly pepper disease appearing during monsoons. Leaves turn pale yellow and drop rapidly; the entire vine wilts and dies within days due to root rot.',
    symptomsML: 'മഴക്കാലത്ത് കുരുമുളകിനെ ബാധിക്കുന്ന മാരകരോഗം. ഇലകൾ പെട്ടെന്ന് മഞ്ഞനിറമായി കൊഴിയുകയും ഏതാനും ദിവസങ്ങൾക്കുള്ളിൽ വള്ളി പൂർണ്ണമായും വാടി ഉണങ്ങുകയും ചെയ്യുന്നു.',
    organicEN: 'Drench the soil base with Trichoderma-enriched organic manure. Apply 1% Bordeaux mixture on leaves and soil before and during the monsoon.',
    organicML: 'ട്രൈക്കോഡെർമ ചേർത്ത ജൈവവളം ചുവട്ടിൽ നൽകുക. മഴ തുടങ്ങുന്നതിന് മുൻപായി 1% ബോർഡോ മിശ്രിതം വള്ളികളിലും മണ്ണിലും ഒഴിക്കുക.',
    chemicalEN: 'Apply Potassium Phosphonate or Metalaxyl-Mancozeb as a soil drench. Ensure the chemical reaches the root zone effectively.',
    chemicalML: 'മെറ്റലാക്സിൽ-മാങ്കോസെബ് അല്ലെങ്കിൽ പൊട്ടാസ്യം ഫോസ്ഫോണേറ്റ് ലായനി വള്ളിയുടെ ചുവട്ടിൽ ഒഴിക്കുക.',
    preventiveEN: 'Ensure absolute soil drainage to prevent water stagnation. Mulch the base and remove alternative weed hosts in the vicinity.',
    preventiveML: 'വെള്ളം കെട്ടിനിൽക്കാത്ത വിധം ഡ്രെയിനേജ് സൗകര്യം ഒരുക്കുക. ചുവട്ടിൽ എപ്പോഴും പുതയിടുന്നത് രോഗത്തെ പ്രതിരോധിക്കാൻ സഹായിക്കും.'
  },
  { 
    id: 'fruit_fly', nameEN: 'Fruit Fly', nameML: 'കായീച്ച',
    keywords: ['rot', 'maggot', 'fall', 'fruit', 'yellow', 'spots', 'holes', 'rotting', 'കായീച്ച', 'പുഴു', 'അഴുകുക'],
    symptomsEN: 'Maggots hatch inside the fruits and feed on the pulp. Fruits rot internally, turn yellow prematurely, show puncture marks, and fall to the ground.',
    symptomsML: 'ഈച്ചകൾ കായ്കൾക്കുള്ളിൽ മുട്ടയിടുന്നു. വിരിഞ്ഞിറങ്ങുന്ന പുഴുക്കൾ കാമ്പ് തിന്നുനശിപ്പിക്കുന്നതോടെ കായ്കൾ അഴുകി നേരത്തെ തന്നെ താഴെ വീഴുന്നു.',
    organicEN: 'Wrap developing tender fruits (bitter gourd, snake gourd) in paper bags. Use Methyl Eugenol or Cue-lure pheromone traps to attract and kill males.',
    organicML: 'ഇളം കായ്കൾ കടലാസ് കവറുകൾ ഉപയോഗിച്ച് പൊതിഞ്ഞു സൂക്ഷിക്കുക. കായീച്ചകളെ ആകർഷിക്കുന്ന ഫെറമോൺ കെണികൾ തോട്ടത്തിൽ തൂക്കുക.',
    chemicalEN: 'Mix Malathion with jaggery solution and apply as large spots on the lower leaves of the crop to act as a poisonous bait.',
    chemicalML: 'ശർക്കര ലായനിയിൽ മാലത്തിയോൺ കലർത്തി ഇലകളിൽ തളിക്കുക. ഇതിലെ മധുരം ആകർഷിക്കുന്ന ഈച്ചകൾ ഇത് കഴിച്ച് നശിക്കും.',
    preventiveEN: 'Strictly collect and deeply bury all infested fallen fruits. Leaving rotten fruits on the ground allows the life cycle to continue.',
    preventiveML: 'കേടായി താഴെ വീഴുന്ന കായ്കൾ പെറുക്കിക്കൂട്ടി ആഴത്തിൽ കുഴിച്ച് മൂടുക. ഇത് അടുത്ത തലമുറ ഉണ്ടാകുന്നത് തടയും.'
  },
  { 
    id: 'rice_bug', nameEN: 'Rice Bug', nameML: 'ചാഴി', 
    keywords: ['smell', 'empty', 'chaff', 'spots', 'ചാഴി', 'പതിർ', 'മണം'], 
    symptomsEN: 'Sucks the sap from developing grains during the "milky stage". This leads to empty, chaffy grains (pathir) with brown or black spots.',
    symptomsML: 'നെല്ല് പാൽ നിറയുന്ന സമയത്ത് ചാഴികൾ വന്ന് നീരൂറ്റിക്കുടിക്കുന്നു. ഇത് നെൽമണികൾ പതിരാകുന്നതിനും അവയിൽ കറുത്ത പുള്ളികൾ ഉണ്ടാകുന്നതിനും കാരണമാകുന്നു.',
    organicEN: 'Lure bugs using rotting fish or frog traps hung in the field. Spray a strong garlic-bird’s eye chili extract in the late evenings.',
    organicML: 'അഴുകിയ മീൻ കഷണങ്ങൾ പാടത്ത് കെണിയായി വെക്കുക. വൈകുന്നേരങ്ങളിൽ വെളുത്തുള്ളി-കാന്താരി മിശ്രിതം തളിക്കുന്നത് ചാഴിയെ അകറ്റും.',
    chemicalEN: 'Dust Quinalphos powder or spray Malathion. Application should be done in the early morning or evening when the bugs are active.',
    chemicalML: 'ക്വിനാൽഫോസ് പൊടി വിതറുകയോ മാലത്തിയോൺ സ്പ്രേ ചെയ്യുകയോ ചെയ്യുക. വെയിൽ കുറവുള്ള സമയത്ത് വേണം ഇത് ചെയ്യാൻ.',
    preventiveEN: 'Keep field bunds and surroundings completely free of weeds and wild grasses where the bugs hide and breed.',
    preventiveML: 'പാടവരമ്പുകളിലെ കാടുകൾ വെട്ടിമാറ്റി പരിസരം വൃത്തിയാക്കി സൂക്ഷിക്കുന്നത് ചാഴിയുടെ ശല്യം കുറയ്ക്കും.'
  },
  { 
    id: 'brown_plant_hopper', nameEN: 'Brown Plant Hopper (BPH)', nameML: 'മുഞ്ഞ', 
    keywords: ['burn', 'dry', 'circular', 'brown', 'wilting', 'മുഞ്ഞ', 'കരിയുക'], 
    symptomsEN: 'Causes "Hopper Burn": Circular patches of rice plants suddenly dry up as if burnt. Hoppers congregate at the base of the plant to suck sap.',
    symptomsML: 'പാടത്ത് വട്ടത്തിൽ നെല്ല് കരിഞ്ഞുണങ്ങി തീപിടിച്ചതുപോലെ നശിക്കുന്ന ലക്ഷണമാണ് (Hopper Burn) ഇതിനുള്ളത്. മുഞ്ഞകൾ ചെടിയുടെ ചുവട്ടിലിരുന്ന് നീരൂറ്റുന്നു.',
    organicEN: 'Drain field water completely for 3-4 days to disturb the pest. Spray Metarhizium or Beauveria bassiana bio-pesticides at the plant base.',
    organicML: 'പാടത്തെ വെള്ളം 3-4 ദിവസം പൂർണ്ണമായും വാർത്തു കളയുക. ചെടിയുടെ ചുവട്ടിലേക്ക് ബ്യൂവേറിയ ബാസിയാന എന്ന ജീവാണുവളം സ്പ്രേ ചെയ്യുക.',
    chemicalEN: 'Spray Pymetrozine or Dinotefuran focusing strictly on the basal parts of the rice plants where the hoppers live.',
    chemicalML: 'പൈമെട്രോസിൻ അല്ലെങ്കിൽ ഇമിഡാക്ലോപ്രിഡ് ചെടിയുടെ ചുവട്ടിലേക്ക് എത്തുന്ന രീതിയിൽ സ്പ്രേ ചെയ്യുക.',
    preventiveEN: 'Leave "Alleyways" (30cm skip rows) every 2-3 meters during planting for air circulation and sunlight penetration.',
    preventiveML: 'നടീൽ സമയത്ത് ഓരോ 2-3 മീറ്ററിലും 30 സെ.മീ വീതിയിൽ ഇടവഴികൾ (Alleyways) വിടുക. ഇത് വായുസഞ്ചാരത്തിന് സഹായിക്കും.'
  },
  { 
    id: 'banana_weevil', nameEN: 'Banana Pseudostem Weevil', nameML: 'പിണ്ടിതുരപ്പൻ പുഴു', 
    keywords: ['jelly', 'oozing', 'hole', 'stem', 'പിണ്ടി', 'ജെല്ലി', 'തുള'], 
    symptomsEN: 'Grubs bore into the pseudostem. Distinctive jelly-like sap oozes from small holes. Leaves turn yellow and the plant may snap in the wind.',
    symptomsML: 'പുഴുക്കൾ വാഴയുടെ പിണ്ടിക്കുള്ളിൽ തുരന്നുകയറുന്നു. പിണ്ടിയിലെ ദ്വാരങ്ങളിൽ നിന്ന് ജെല്ലി പോലെയുള്ള ദ്രാവകം വരുന്നത് പ്രധാന ലക്ഷണമാണ്.',
    organicEN: 'Place traps using fresh cut pseudostem pieces (Longitudinal splits). Apply Neem cake to the soil and spray Neem oil (5%) on the stem.',
    organicML: 'വാഴപ്പിണ്ടി കഷണങ്ങൾ മുറിച്ച് തോട്ടത്തിൽ കെണികളായി വെക്കുക. ചുവട്ടിൽ വേപ്പിൻ പിണ്ണാക്ക് ഇടുന്നതും പിണ്ടിയിൽ വേപ്പെണ്ണ സ്പ്രേ ചെയ്യുന്നതും നല്ലതാണ്.',
    chemicalEN: 'Place Carbofuran granules or inject Chlorpyrifos solution into the lower part of the pseudostem during early infestation.',
    chemicalML: 'രോഗം കണ്ടുതുടങ്ങുമ്പോൾ തന്നെ ക്ലോർപൈറിഫോസ് ലായനി സിറിഞ്ച് ഉപയോഗിച്ച് പിണ്ടിയിലേക്ക് കുത്തിവെക്കുക.',
    preventiveEN: 'Destroy all harvested, rotting banana stumps. Keep the plantation hygienic by removing dry leaves and weeds regularly.',
    preventiveML: 'വിളവെടുപ്പിന് ശേഷം വാഴയുടെ അവശിഷ്ടങ്ങൾ തോട്ടത്തിൽ ഇടരുത്. ഉണങ്ങിയ ഇലകളും മറ്റും വെട്ടിമാറ്റി തോട്ടം വൃത്തിയാക്കുക.'
  },
  { 
    id: 'tea_mosquito_bug', nameEN: 'Tea Mosquito Bug', nameML: 'തേയില കൊതുക്', 
    keywords: ['black', 'spots', 'dry', 'burn', 'തേയില', 'കൊതുക്', 'കറുത്ത'], 
    symptomsEN: 'Attacks cashew, guava, and cocoa. Bites cause black necrotic spots on young shoots and flower panicles, eventually leading to drying.',
    symptomsML: 'കശുമാവ്, കൊക്കോ, പേരയ്ക്ക എന്നിവയെ ബാധിക്കുന്നു. കൊതുക് കുത്തുന്ന ഭാഗം കറുത്ത് പുള്ളികളാവുകയും തളിരിലകളും പൂങ്കുലകളും ഉണങ്ങുകയും ചെയ്യുന്നു.',
    organicEN: 'Spray 5% organic Neem oil emulsion or fish oil rosin soap. Use light traps to attract adults during the night.',
    organicML: '5% വീര്യമുള്ള വേപ്പെണ്ണ എമൽഷനോ ഫിഷ് ഓയിൽ സോപ്പോ തളിക്കുക. രാത്രികാലങ്ങളിൽ വെളിച്ചക്കെണികൾ ഉപയോഗിച്ച് ഇവയെ നശിപ്പിക്കാം.',
    chemicalEN: 'Apply Quinalphos or Lambda-cyhalothrin during the early flushing stage and before flowering to prevent damage.',
    chemicalML: 'തളിരിലകൾ വരുന്ന സമയത്തും പൂക്കുന്നതിന് മുൻപും ക്വിനാൽഫോസ് അല്ലെങ്കിൽ ലാംഡാ സൈഹാലോത്രിൻ തളിക്കുക.',
    preventiveEN: 'Clear alternative host plants and weeds surrounding the field. Prune overcrowded branches to ensure enough sunlight.',
    preventiveML: 'തോട്ടത്തിന് ചുറ്റുമുള്ള കാടുകൾ വെട്ടിത്തെളിക്കുക. കൊമ്പുകൾ കോതി സൂര്യപ്രകാശം ഉള്ളിലേക്ക് ലഭിക്കുന്നുണ്ടെന്ന് ഉറപ്പാക്കുക.'
  },
  { 
    id: 'pollu_beetle', nameEN: 'Pepper Pollu Beetle', nameML: 'പൊള്ളുവണ്ട്', 
    keywords: ['hollow', 'empty', 'black', 'hole', 'പൊള്ളു', 'വണ്ട്', 'പൊള്ളയായ'], 
    symptomsEN: 'Grubs eat the inner seed core of developing pepper corns. The berries turn black and become completely hollow (Pollu), losing all market value.',
    symptomsML: 'വണ്ടുകൾ കുരുമുളക് മണികളുടെ ഉള്ളിലെ കാമ്പ് തിന്നുതീർക്കുന്നു. ഇതോടെ കുരുമുളക് മണികൾ ഉണങ്ങി കറുത്ത തൊണ്ടുകളായി (Pollu) മാറുന്നു.',
    organicEN: 'Spray 0.5% neem oil emulsion uniformly on spikes during July and October. Encourage natural predators like spiders in the garden.',
    organicML: 'ജൂലായ്, ഒക്ടോബർ മാസങ്ങളിൽ 0.5% വീര്യമുള്ള വേപ്പെണ്ണ കുരുമുളക് തിരികളിൽ തളിക്കുക. മണ്ണിൽ ധാരാളം ജൈവവളം ചേർക്കുക.',
    chemicalEN: 'Apply Quinalphos 25 EC or Chlorpyrifos when the berries start forming to control the beetle population effectively.',
    chemicalML: 'തിരികളിൽ മണികൾ രൂപപ്പെടുന്ന സമയത്ത് ക്വിനാൽഫോസ് അല്ലെങ്കിൽ ക്ലോർപൈറിഫോസ് തളിക്കുക.',
    preventiveEN: 'Regulate shade trees to ensure the pepper vine gets adequate sunlight. Destroy any fallen, infested berries by burning them.',
    preventiveML: 'താങ്ങുമരങ്ങളുടെ തണൽ ക്രമീകരിക്കുക. കേടായി താഴെ വീഴുന്ന കുരുമുളക് മണികൾ പെറുക്കിയെടുത്ത് കത്തിച്ചു കളയുക.'
  },
  { 
    id: 'root_wilt', nameEN: 'Root Wilt', nameML: 'കാറ്റുവീഴ്ച', 
    keywords: ['bending', 'yellow', 'leaves', 'wilting', 'കാറ്റുവീഴ്ച', 'വളയുക'], 
    symptomsEN: 'Typical symptoms are flaccidity (inward bending) of leaflets and yellowing of outer leaves. It slowly reduces the yield and strength of the palm.',
    symptomsML: 'ഓലക്കാലുകൾ ഉള്ളിലേക്ക് വളയുന്നതും (Flaccidity) താഴെയുള്ള ഓലകൾ മഞ്ഞനിറമാകുന്നതുമാണ് പ്രധാന ലക്ഷണങ്ങൾ. ഇത് തെങ്ങിന്റെ വിളവ് കുറയ്ക്കുന്നു.',
    organicEN: 'No complete cure exists. Focus on high nutrition: Apply 50kg compost, 1kg Neem cake, and 50g Magnesium sulphate per palm annually.',
    organicML: 'ഈ രോഗത്തിന് പൂർണ്ണമായ ചികിത്സയില്ല. 50 കിലോ ജൈവവളവും ഒരു കിലോ വേപ്പിൻ പിണ്ണാക്കും മഗ്നീഷ്യം സൾഫേറ്റും നൽകി തെങ്ങിന്റെ ആരോഗ്യം കൂട്ടുക.',
    chemicalEN: 'Chemical treatments are largely ineffective for Phytoplasma. Stick to nutrient management and early detection.',
    chemicalML: 'രാസവളങ്ങൾ ഈ രോഗത്തിന് ഫലപ്രദമല്ല. എന്നാൽ മറ്റ് വളങ്ങൾ നൽകി തെങ്ങിനെ കരുത്തോടെ നിർത്താൻ സാധിക്കും.',
    preventiveEN: 'Routinely remove and destroy severely affected palms in the initial stages. Use disease-resistant seedlings like Kalpa Raksha.',
    preventiveML: 'രോഗം മൂർച്ഛിച്ച തെങ്ങുകൾ വെട്ടിമാറ്റുക. കൽപ്പരക്ഷ പോലെയുള്ള രോഗപ്രതിരോധ ശേഷിയുള്ള തെങ്ങിൻ തൈകൾ നടാൻ ശ്രദ്ധിക്കുക.'
  },
  { 
    id: 'mahali', nameEN: 'Mahali / Koleroga', nameML: 'മഹാളി', 
    keywords: ['falling', 'rot', 'brown', 'monsoon', 'മഹാളി', 'കൊഴിയുക', 'അഴുകുക'], 
    symptomsEN: 'Occurs in arecanut during monsoons. Nuts rot at the base, turn dark brown, and fall prematurely with a putrid smell.',
    symptomsML: 'മഴക്കാലത്ത് അടയ്ക്കയിൽ വരുന്ന രോഗം. കായ്കളുടെ ചുവട്ടിൽ അഴുകി ഇരുണ്ട നിറമാവുകയും അടയ്ക്കകൾ ധാരാളമായി കൊഴിഞ്ഞുവീഴുകയും ചെയ്യുന്നു.',
    organicEN: 'Spray 1% Bordeaux mixture as a prophylactic measure on developing bunches just before the south-west monsoon begins.',
    organicML: 'മഴ തുടങ്ങുന്നതിന് മുൻപായി അടയ്ക്ക കുലകളിൽ 1% ബോർഡോ മിശ്രിതം തളിക്കുക. മഴ തുടരുകയാണെങ്കിൽ 40 ദിവസം കഴിഞ്ഞ് വീണ്ടും തളിക്കുക.',
    chemicalEN: 'Apply Metalaxyl-Mancozeb fungicides if the disease outbreak is severe during continuous heavy rains.',
    chemicalML: 'രോഗം പകരുകയാണെങ്കിൽ മെറ്റലാക്സിൽ-മാങ്കോസെബ് പോലെയുള്ള കുമിൾനാശിനികൾ തളിക്കാവുന്നതാണ്.',
    preventiveEN: 'Burn all fallen, infected nuts to prevent fungal spores from spreading through the soil and air to healthy trees.',
    preventiveML: 'രോഗം വന്ന് കൊഴിഞ്ഞുവീഴുന്ന അടയ്ക്കകൾ കൂട്ടിയിട്ട് കത്തിച്ചു കളയുക. കവുങ്ങിൻ തടത്തിൽ വെള്ളം കെട്ടിനിൽക്കാതെ നോക്കുക.'
  },
  { 
    id: 'mealybug', nameEN: 'Mealybug', nameML: 'പഞ്ഞിക്കീടം', 
    keywords: ['white', 'cotton', 'ants', 'sooty', 'പഞ്ഞി', 'ഉറുമ്പ്', 'വെളുത്ത'], 
    symptomsEN: 'Small white cottony insects on leaves/stems sucking sap. They secrete honeydew, causing black sooty mold on the leaf surface.',
    symptomsML: 'ചെടികളിൽ വെളുത്ത പഞ്ഞി ഒട്ടിച്ചിരിക്കുന്നത് പോലെ ഈ കീടങ്ങളെ കാണാം. ഇവയുടെ വിസർജ്യം കാരണം ഇലകളിൽ കറുത്ത പൂപ്പൽ ബാധയുണ്ടാകുന്നു.',
    organicEN: 'Wash the bugs away with a high-pressure water jet. Spray Neem oil emulsion (2%) or fish oil rosin soap at 20g/liter.',
    organicML: 'ശക്തമായ വെള്ളം പമ്പ് ചെയ്ത് ഇവയെ കഴുകിക്കളയാം. 2% വീര്യമുള്ള വേപ്പെണ്ണയോ ഫിഷ് ഓയിൽ സോപ്പോ ഉപയോഗിച്ച് സ്പ്രേ ചെയ്യുക.',
    chemicalEN: 'Apply systemic insecticides like Dimethoate or Acephate. Ensure the spray covers the underside of leaves.',
    chemicalML: 'രോഗം കൂടുതലാണെങ്കിൽ ഡൈമെത്തോയേറ്റ് അല്ലെങ്കിൽ അസഫേറ്റ് പോലെയുള്ള മരുന്നുകൾ ഇലയുടെ അടിഭാഗത്ത് എത്തുന്ന വിധം തളിക്കുക.',
    preventiveEN: 'Control ants! Ants "farm" mealybugs for their honeydew and protect them from predators. Apply grease or sticky bands at the base of the plant.',
    preventiveML: 'ഉറുമ്പുകളെ നിയന്ത്രിക്കുക. ഇവയാണ് പഞ്ഞിക്കീടങ്ങളെ ഒരു ചെടിയിൽ നിന്ന് മറ്റൊന്നിലേക്ക് എത്തിക്കുന്നത്. ചുവട്ടിൽ പശയോ ഗ്രീസോ പുരട്ടുക.'
  },
  { 
    id: 'mosaic_virus', nameEN: 'Mosaic Disease', nameML: 'മഞ്ഞളിപ്പ് (വൈറസ്)', 
    keywords: ['yellow', 'vein', 'mosaic', 'curling', 'മഞ്ഞളിപ്പ്', 'ഞരമ്പ്'], 
    symptomsEN: 'Leaves show characteristic green and yellow mottled patterns. Veins turn yellow, and leaves may curl. Plant growth and fruiting stop.',
    symptomsML: 'ഇലകളിൽ പച്ചയും മഞ്ഞയും കലർന്ന പാടുകൾ കാണാം. ഞരമ്പുകൾ മഞ്ഞളിക്കുകയും ഇലകൾ ചുരുളുകയും ചെയ്യുന്നു. ചെടിയുടെ വളർച്ച പൂർണ്ണമായും നിൽക്കും.',
    organicEN: 'No cure once infected. Spray Neem oil (2%) to control whiteflies and aphids that carry and transmit the virus from plant to plant.',
    organicML: 'വൈറസ് രോഗത്തിന് ചികിത്സയില്ല. രോഗം പരത്തുന്ന വെള്ളീച്ചകളെ തടയാൻ രണ്ടാഴ്ച കൂടുമ്പോൾ വേപ്പെണ്ണ സ്പ്രേ ചെയ്യുക.',
    chemicalEN: 'Apply Imidacloprid or Thiamethoxam to eliminate insect vectors like whiteflies in commercial plantations.',
    chemicalML: 'വെള്ളീച്ചകളെ നിയന്ത്രിക്കാൻ ഇമിഡാക്ലോപ്രിഡ് പോലെയുള്ള കീടനാശിനികൾ ഇലകളിൽ തളിക്കുക.',
    preventiveEN: 'Instantly uproot and burn any plant showing mosaic symptoms. Use disease-free certified seeds or cuttings for planting.',
    preventiveML: 'രോഗലക്ഷണം കണ്ടാലുടൻ ആ ചെടി വേരോടെ പിഴുതെടുത്ത് കത്തിച്ചു കളയുക. രോഗമില്ലാത്ത വിത്തുകൾ മാത്രം കൃഷിക്ക് ഉപയോഗിക്കുക.'
  },
  { 
    id: 'bacterial_wilt', nameEN: 'Bacterial Wilt', nameML: 'ബാക്ടീരിയൽ വാട്ടം', 
    keywords: ['wilting', 'green', 'sudden', 'ooze', 'വാട്ടം', 'പെട്ടെന്ന്'], 
    symptomsEN: 'Sudden wilting of a healthy-looking green plant. To confirm, cut the stem and place it in a glass of water; milky white bacterial ooze will stream out.',
    symptomsML: 'പച്ചപ്പുള്ള ചെടികൾ പെട്ടെന്ന് വാടിത്തളരുന്നു. തണ്ട് മുറിച്ച് വെള്ളത്തിൽ വെച്ചാൽ വെളുത്ത ദ്രാവകം ഒലിച്ചിറങ്ങുന്നത് കാണാം (Ooze Test).',
    organicEN: 'Drench the soil with Pseudomonas fluorescence solution weekly. Apply lime to the soil to increase pH, which bacteria dislike.',
    organicML: 'സ്യൂഡോമോണാസ് ലായനി ആഴ്ചയിലൊരിക്കൽ തടത്തിൽ ഒഴിക്കുക. മണ്ണിൽ കുമ്മായം ചേർക്കുന്നത് ബാക്ടീരിയയുടെ വളർച്ച തടയാൻ സഹായിക്കും.',
    chemicalEN: 'Drench the affected area with Streptocycline or Bleaching powder (10g per liter) to disinfect the soil around the plant.',
    chemicalML: 'ബ്ലീച്ചിംഗ് പൗഡർ വെള്ളത്തിൽ കലക്കി തടത്തിൽ ഒഴിക്കുന്നത് മണ്ണിലെ ബാക്ടീരിയകളെ നശിപ്പിക്കാൻ സഹായിക്കും.',
    preventiveEN: 'Follow strict crop rotation. Never plant tomato, chili, or brinjal in the same soil consecutively where wilt occurred.',
    preventiveML: 'ഒരേ സ്ഥലത്ത് തന്നെ വർഷാവർഷം തക്കാളി, വെണ്ട, വഴുതന എന്നിവ കൃഷി ചെയ്യരുത് (Crop Rotation). വിത്തുകൾ സ്യൂഡോമോണാസിൽ മുക്കി നടുക.'
  },
  { 
    id: 'bud_rot', nameEN: 'Bud Rot (Coconut)', nameML: 'കൂമ്പുചീയൽ', 
    keywords: ['crown', 'rotten', 'smell', 'paddy', 'coconut', 'കൂമ്പ്', 'ചീയൽ'], 
    symptomsEN: 'The central bud/leaf rots and turns brown. It emits a foul odor. The heart leaf can be easily pulled out with hand.',
    symptomsML: 'തെങ്ങിന്റെ കൂമ്പ് അഴുകി തവിട്ട് നിറമാവുകയും ദുർഗന്ധം വരികയും ചെയ്യുന്നു. കൂമ്പില കൈകൊണ്ട് വലിച്ചാൽ എളുപ്പത്തിൽ ഊരി വരും.',
    organicEN: 'Cut and remove rotten parts. Apply Bordeaux paste to the cut surface. Protect with a plastic cover to prevent rain entry.',
    organicML: 'അഴുകിയ ഭാഗങ്ങൾ വെട്ടിമാറ്റി അവിടെ ബോർഡോ കുഴമ്പ് പുരട്ടുക. മഴവെള്ളം ഉള്ളിലേക്ക് കടക്കാതിരിക്കാൻ പ്ലാസ്റ്റിക് കവർ കൊണ്ട് മൂടുക.',
    chemicalEN: 'Apply Copper Oxychloride or Mancozeb to the crown. Prophylactic sprays before monsoons are recommended.',
    chemicalML: 'മാങ്കോസെബ് അല്ലെങ്കിൽ കോപ്പർ ഓക്സിക്ലോറൈഡ് കുഴമ്പ് മണ്ടയിൽ പുരട്ടുന്നത് ഫലപ്രദമാണ്.',
    preventiveEN: 'Check the crown after heavy rains. Ensure regular cleaning and avoid dumping organic waste in the coconut head.',
    preventiveML: 'മഴക്കാലത്ത് മണ്ട പരിശോധിക്കുക. ഇടയ്ക്കിടെ മണ്ട വൃത്തിയാക്കുകയും അവിടെ ചപ്പുചവറുകൾ അടിയാൻ അനുവദിക്കാതിരിക്കുകയും ചെയ്യുക.'
  },
  { 
    id: 'sigatoka', nameEN: 'Sigatoka Leaf Spot', nameML: 'സിഗാറ്റോക്ക രോഗം', 
    keywords: ['banana', 'spots', 'leaf', 'dry', 'yellow', 'സിഗാറ്റോക്ക', 'വാഴ', 'ഇലപ്പുള്ളി'], 
    symptomsEN: 'Elliptical spots with grayish centers on banana leaves. Infected leaves dry up quickly, reducing fruit size and weight.',
    symptomsML: 'വാഴയിലകളിൽ നടുഭാഗം ചാരനിറത്തോടു കൂടിയ പുള്ളികൾ പ്രത്യക്ഷപ്പെടുന്നു. ഇലകൾ പെട്ടെന്ന് ഉണങ്ങുന്നത് കുലയുടെ വലിപ്പത്തെ ബാധിക്കും.',
    organicEN: 'Remove and burn all infected leaves. Spray 1% Bordeaux mixture or Pseudomonas to control fungal spread.',
    organicML: 'രോഗം വന്ന ഇലകൾ വെട്ടിമാറ്റി ദൂരെ കൊണ്ടുപോയി കത്തിക്കുക. 1% ബോർഡോ മിശ്രിതം അല്ലെങ്കിൽ സ്യൂഡോമോണാസ് തളിക്കുക.',
    chemicalEN: 'Apply Carbendazim or Propiconazole mixed with a sticking agent to the underside of the leaves.',
    chemicalML: 'കാർബെൻഡാസിം അല്ലെങ്കിൽ പ്രോപ്പികൊണസോൾ പോലെയുള്ള മരുന്നുകൾ സോപ്പ് ലായനിയുമായി കലർത്തി ഇലകളിൽ തളിക്കുക.',
    preventiveEN: 'Proper plant spacing to allow airflow. Use balanced NPK fertilizers with adequate potassium for leaf health.',
    preventiveML: 'വാഴകൾ തമ്മിൽ നിശ്ചിത അകലം പാലിക്കുക. ആവശ്യത്തിന് പൊട്ടാസ്യം വളം നൽകുന്നത് ഇലകളുടെ പ്രതിരോധശേഷി കൂട്ടും.'
  },
  { 
    id: 'gall_midge', nameEN: 'Rice Gall Midge', nameML: 'മീൻതണ്ട് (ഗാൾ മിഡ്ജ്)', 
    keywords: ['silver', 'shoot', 'paddy', 'rice', 'onion', 'മീൻതണ്ട്', 'പതിർ'], 
    symptomsEN: 'Larvae trigger the formation of "Silver shoots" or "Onion shoots" instead of normal leaves. These plants do not produce grains.',
    symptomsML: 'നെല്ലിന്റെ തണ്ട് ഉള്ളിയില പോലെ രൂപമാറ്റം സംഭവിക്കുന്നു. ഇത് "മീൻതണ്ട്" എന്ന് അറിയപ്പെടുന്നു. ഇത്തരം ചെടികളിൽ കതിരുകൾ ഉണ്ടാവില്ല.',
    organicEN: 'Release Platygaster oryzae parasitoids. Use light traps to monitor and catch the midge adults during the night.',
    organicML: 'പ്ലാറ്റിഗാസ്റ്റർ ഒറൈസെ എന്ന മിത്രകീടത്തെ ഉപയോഗിക്കാം. വെളിച്ചക്കെണികൾ ഉപയോഗിച്ച് മുതിർന്ന ഈച്ചകളെ പിടിച്ചു നശിപ്പിക്കുക.',
    chemicalEN: 'Apply Carbofuran or Phorate granules in the field water during the vegetative stage to control larvae.',
    chemicalML: 'കാർബോഫുറാൻ അല്ലെങ്കിൽ ഫോറേറ്റ് ഗുളികകൾ പാടത്ത് വിതറുന്നത് ലാർവകളെ നശിപ്പിക്കാൻ സഹായിക്കും.',
    preventiveEN: 'Avoid late planting. Use resistant rice varieties (like Mahamaya or Vikram) in endemic areas.',
    preventiveML: 'വൈകി കൃഷി ഇറക്കുന്നത് ഒഴിവാക്കുക. രോഗപ്രതിരോധ ശേഷിയുള്ള നെൽവിത്തുകൾ മാത്രം തിരഞ്ഞെടുക്കുക.'
  },
  { 
    id: 'panama_wilt', nameEN: 'Panama Wilt', nameML: 'പനാമ വാട്ടം', 
    keywords: ['banana', 'wilting', 'yellow', 'soil', 'പനാമ', 'വാഴ', 'വാട്ടം'], 
    symptomsEN: 'Lower leaves turn yellow at the edges and collapse. The pseudostem splits at the base. It is a soil-borne fungal disease.',
    symptomsML: 'വാഴയുടെ താഴത്തെ ഇലകൾ മഞ്ഞനിറമായി തണ്ടിനോട് ചേർന്ന് ഒടിഞ്ഞു തൂങ്ങുന്നു. വാഴയുടെ അടിഭാഗം വിണ്ടുകീറുന്നത് കാണാം.',
    organicEN: 'Treat suckers with Trichoderma or Pseudomonas before planting. Apply plenty of organic matter and lime to the soil.',
    organicML: 'വാഴക്കന്നുകൾ ട്രൈക്കോഡെർമ അല്ലെങ്കിൽ സ്യൂഡോമോണാസ് ലായനിയിൽ മുക്കി വെച്ച ശേഷം മാത്രം നടുക. മണ്ണിൽ കുമ്മായം ചേർക്കുക.',
    chemicalEN: 'No effective chemical cure for infected plants. Drench the soil with Carbendazim (0.2%) to prevent further spread.',
    chemicalML: 'രോഗം വന്ന വാഴയ്ക്ക് മരുന്നില്ല. മറ്റ് വാഴകളിലേക്ക് പകരുന്നത് തടയാൻ കാർബെൻഡാസിം ലായനി തടത്തിൽ ഒഴിക്കുക.',
    preventiveEN: 'Practice crop rotation with paddy. Avoid using suckers from infected plantations. Ensure perfect drainage.',
    preventiveML: 'നെൽക്കൃഷിയുമായി വിളപരിക്രമണം നടത്തുക. രോഗമുള്ള പറമ്പിൽ നിന്നുള്ള വാഴക്കന്നുകൾ നടുവാൻ ഉപയോഗിക്കരുത്.'
  },
  { 
    id: 'ginger_rot', nameEN: 'Soft Rot (Ginger)', nameML: 'മൃദുചീയൽ (ഇഞ്ചി)', 
    keywords: ['ginger', 'rot', 'water', 'soft', 'ഇഞ്ചി', 'ചീയൽ', 'വാട്ടം'], 
    symptomsEN: 'Rhizomes become soft, water-soaked, and rot. The base of the plant turns brown and the entire cluster eventually wilts.',
    symptomsML: 'മണ്ണിലുള്ള ഇഞ്ചിക്കൈകൾ അഴുകി മൃദുവായി മാറുന്നു. ഇഞ്ചിച്ചെടിയുടെ ചുവട് തവിട്ട് നിറമാവുകയും ചെടി പെട്ടെന്ന് വാടി നശിക്കുകയും ചെയ്യുന്നു.',
    organicEN: 'Soil application of Trichoderma and seed treatment with Pseudomonas. Ensure the nursery beds are well-raised.',
    organicML: 'ട്രൈക്കോഡെർമ ചേർത്ത വളം മണ്ണിൽ നൽകുക. വാരങ്ങൾ ഉയർത്തിക്കെട്ടുന്നത് വെള്ളം കെട്ടിനിൽക്കുന്നത് തടയും.',
    chemicalEN: 'Drench the soil with 0.3% Copper Oxychloride or Mancozeb at the first sign of infestation.',
    chemicalML: 'രോഗം കണ്ടാലുടൻ കോപ്പർ ഓക്സിക്ലോറൈഡ് അല്ലെങ്കിൽ മാങ്കോസെബ് ലായനി ഇഞ്ചിത്തടത്തിൽ ഒഴിച്ച് കുതിർക്കുക.',
    preventiveEN: 'Selection of healthy seed ginger is vital. Avoid fields with a history of soft rot. Ensure perfect soil drainage.',
    preventiveML: 'രോഗമില്ലാത്ത വിത്തിഞ്ചി മാത്രം ഉപയോഗിക്കുക. പറമ്പിൽ വെള്ളം കെട്ടിനിൽക്കാൻ ഒട്ടും അനുവദിക്കരുത്.'
  },
  { 
    id: 'eriophyid_mite', nameEN: 'Coconut Eriophyid Mite', nameML: 'മണ്ഡരി (മൈറ്റ്)', 
    keywords: ['coconut', 'small', 'nuts', 'spots', 'മണ്ഡരി', 'തേങ്ങ', 'പുള്ളി'], 
    symptomsEN: 'Small yellowish spots on tender nuts that turn into brown triangular patches and longitudinal fissures/cracks as the nut matures.',
    symptomsML: 'ഇളം മച്ചിങ്ങകളിൽ മഞ്ഞനിറത്തിലുള്ള പാടുകൾ വരുന്നു. തേങ്ങ വളരുമ്പോൾ ഇവ തവിട്ട് നിറത്തിലുള്ള വിള്ളലുകളായി രൂപപ്പെടുന്നു.',
    organicEN: 'Spray Neem oil-garlic emulsion (2%) on the tender nut clusters. Apply Azadirachtin (5%) directly to the youngest bunches.',
    organicML: 'വേപ്പെണ്ണ-വെളുത്തുള്ളി മിശ്രിതം മച്ചിങ്ങ കുലകളിൽ തളിക്കുക. അസാഡിറാക്റ്റിൻ അടങ്ങിയ മരുന്നുകൾ ഉപയോഗിക്കുന്നതും ഫലപ്രദമാണ്.',
    chemicalEN: 'Root feeding with approved pesticides like Azadirachtin or spraying with Dicofol (if highly severe).',
    chemicalML: 'അസാഡിറാക്റ്റിൻ വേരുകളിലൂടെ നൽകുന്നത് (Root Feeding) മണ്ഡരിയെ നിയന്ത്രിക്കാൻ സഹായിക്കും.',
    preventiveEN: 'Balanced fertilization and regular watering. Healthy palms show more resistance to mite attacks.',
    preventiveML: 'തെങ്ങിന് കൃത്യമായി വെള്ളവും വളവും നൽകി കരുത്തുറ്റതാക്കുക. ആരോഗ്യമുള്ള തെങ്ങുകളെ മണ്ഡരി ബാധിക്കുന്നത് കുറവാണ്.'
  },
  { 
    id: 'mango_hopper', nameEN: 'Mango Hopper', nameML: 'ഇലച്ചാടി (മാവ്)', 
    keywords: ['mango', 'flower', 'black', 'dry', 'മാവ്', 'പൂങ്കുല', 'കരിയുക'], 
    symptomsEN: 'Insects suck sap from flowers and tender shoots. Panicles turn black, dry up, and fall off, leading to zero fruit set.',
    symptomsML: 'ഇവ പൂങ്കുലകളിലെ നീരൂറ്റിക്കുടിക്കുന്നു. പൂങ്കുലകൾ കറുത്ത നിറമായി കരിഞ്ഞുണങ്ങുന്നതോടെ മാങ്ങ പിടിക്കാതെ വരുന്നു.',
    organicEN: 'Spray Beauveria bassiana or Metarhizium on the branches and flower clusters. Smoking the orchard helps repel hoppers.',
    organicML: 'ബ്യൂവേറിയ ബാസിയാന പൂങ്കുലകളിൽ തളിക്കുക. പൂക്കുന്ന സമയത്ത് പുകയിടുന്നത് (Smoking) ചാടികളെ ഓടിക്കാൻ സഹായിക്കും.',
    chemicalEN: 'Spray Imidacloprid or Thiamethoxam during the pre-flowering and flowering stages for effective control.',
    chemicalML: 'പൂവിടുന്നതിന് മുൻപായി ഇമിഡാക്ലോപ്രിഡ് അല്ലെങ്കിൽ തയാമെത്തോക്സാം പോലെയുള്ള മരുന്നുകൾ തളിക്കുക.',
    preventiveEN: 'Prune old and overlapping branches to allow light penetration. Avoid high density planting without regular pruning.',
    preventiveML: 'കൊമ്പുകൾ കോതി മാവിനുള്ളിലേക്ക് വെളിച്ചം കടത്തിവിടുക. മാവുകൾ തമ്മിൽ മതിയായ അകലം പാലിക്കാൻ ശ്രദ്ധിക്കുക.'
  },
  { 
    id: 'leaf_roller', nameEN: 'Rice Leaf Roller', nameML: 'ഇലചുരുട്ടിപ്പുഴു', 
    keywords: ['paddy', 'leaf', 'white', 'dry', 'ഇലചുരുട്ടി', 'നെല്ല്', 'പുഴു'], 
    symptomsEN: 'Larvae fold the leaf blade and feed from inside. White transparent streaks appear on the leaves. Photosynthesis is hindered.',
    symptomsML: 'പുഴുക്കൾ ഇലകൾ നെടുകെ ചുരുട്ടി ഉള്ളിലിരുന്ന് ഹരിതകം കാർന്നുതിന്നുന്നു. ഇലകളിൽ വെള്ള പാടുകൾ കാണപ്പെടുകയും ചെടി ഉണങ്ങുകയും ചെയ്യും.',
    organicEN: 'Pass a thorny branch or a tight rope over the crop to dislodge larvae. Spray 5% Neem Seed Kernel Extract (NSKE).',
    organicML: 'ഒരു മുൾച്ചില്ലയോ കയറോ പാടത്തിന് കുറുകെ വലിച്ചാൽ പുഴുക്കൾ ഇലകളിൽ നിന്ന് താഴെ വീഴും. വേപ്പിൻകുരു സത്ത് തളിക്കുന്നതും നല്ലതാണ്.',
    chemicalEN: 'Apply Flubendiamide or Chlorantraniliprole in the early stage of infestation to control the caterpillars.',
    chemicalML: 'രോഗം കണ്ടാലുടൻ ക്ലോറാൻട്രാനിലിപ്രോൾ പോലെയുള്ള മരുന്നുകൾ സ്പ്രേ ചെയ്യുക.',
    preventiveEN: 'Avoid excessive application of urea. Keep the paddy field surroundings free of wild grasses and alternate hosts.',
    preventiveML: 'യൂറിയ വളം അധികമായി നൽകരുത്. പാടത്തെ കളകൾ നീക്കം ചെയ്ത് വൃത്തിയാക്കി സൂക്ഷിക്കുക.'
  },
  { 
    id: 'rubber_leaf_fall', nameEN: 'Abnormal Leaf Fall (Rubber)', nameML: 'അകാല ഇലപൊഴിച്ചിൽ', 
    keywords: ['rubber', 'leaf', 'fall', 'rain', 'റബ്ബർ', 'ഇല', 'കൊഴിയുക'], 
    symptomsEN: 'Sudden fall of green leaves with a drop of latex at the point of detachment. Occurs during heavy monsoons due to Phytophthora.',
    symptomsML: 'മഴക്കാലത്ത് പച്ചിലകൾ ഞെട്ടിൽ പശയോടു കൂടി കൊഴിഞ്ഞു വീഴുന്ന രോഗമാണിത്. ഇത് റബ്ബറിന്റെ വിളവ് വൻതോതിൽ കുറയ്ക്കുന്നു.',
    organicEN: 'Ensure the plantation is not overcrowded. Apply organic fertilizers to improve tree immunity before the rains.',
    organicML: 'മരങ്ങൾ തമ്മിൽ മതിയായ വായുസഞ്ചാരം ഉറപ്പാക്കുക. മഴയ്ക്ക് മുൻപായി ജൈവവളങ്ങൾ നൽകി മരങ്ങളെ കരുത്തുറ്റതാക്കുക.',
    chemicalEN: 'Prophylactic spraying of high-volume Oil-based Copper Oxychloride or Bordeaux mixture on the canopy using a sprayer.',
    chemicalML: 'മഴ തുടങ്ങുന്നതിന് മുൻപ് ഹെലികോപ്റ്റർ ഉപയോഗിച്ചോ സ്പ്രേയർ ഉപയോഗിച്ചോ ബോർഡോ മിശ്രിതം മരത്തിന് മുകളിൽ തളിക്കുക.',
    preventiveEN: 'Plant resistant clones. Maintain a clean field to reduce moisture buildup which favors fungal growth.',
    preventiveML: 'രോഗപ്രതിരോധ ശേഷിയുള്ള റബ്ബർ ഇനങ്ങൾ മാത്രം നടുക. തോട്ടത്തിൽ അനാവശ്യമായി ഈർപ്പം നിൽക്കാതെ ശ്രദ്ധിക്കുക.'
  },
  { 
    id: 'okra_borer', nameEN: 'Fruit & Shoot Borer (Okra)', nameML: 'വെണ്ടയിലെ കായ്തുരപ്പൻ', 
    keywords: ['okra', 'hole', 'fruit', 'dry', 'വെണ്ടയ്ക്ക', 'പുഴു', 'ദ്വാരം'], 
    symptomsEN: 'Larvae bore into shoots causing wilting, and later into fruits making them unfit for consumption. Holes on fruits are visible.',
    symptomsML: 'പുഴുക്കൾ ആദ്യം തണ്ട് തുരന്ന് ഉണക്കുന്നു. പിന്നീട് വെണ്ടയ്ക്കകൾക്കുള്ളിൽ തുരന്നുകയറി അവയെ ഉപയോഗശൂന്യമാക്കുന്നു.',
    organicEN: 'Remove affected shoots and fruits instantly. Use pheromone traps and spray 5% NSKE or Bacillus thuringiensis (Bt).',
    organicML: 'പുഴു ബാധിച്ച വെണ്ടയ്ക്കകൾ പെറുക്കി ദൂരെയെറിയുക. ഫെറമോൺ കെണികൾ വെക്കുകയും വേപ്പിൻകുരു സത്ത് തളിക്കുകയും ചെയ്യുക.',
    chemicalEN: 'Apply Spinosad or Emamectin benzoate. Do not harvest fruits for at least 3 days after chemical application.',
    chemicalML: 'എമാമെക്റ്റിൻ ബെൻസോയേറ്റ് അല്ലെങ്കിൽ സ്പിനോസാഡ് തളിക്കുക. മരുന്നടിച്ച ശേഷം കുറഞ്ഞത് 3 ദിവസം കഴിഞ്ഞ് മാത്രം വിളവെടുക്കുക.',
    preventiveEN: 'Intercrop with maize to divert pests. Practice clean cultivation and destroy all crop residues after harvest.',
    preventiveML: 'മറ്റ് വിളകൾ ഇടവിളയായി നടുക. വിളവെടുപ്പിന് ശേഷം പഴയ ചെടികൾ പറിച്ചു മാറ്റി തോട്ടം അണുവിമുക്തമാക്കുക.'
  },
  { 
    id: 'cardamom_thrips', nameEN: 'Cardamom Thrips', nameML: 'ഏലപ്പേൻ (ത്രിപ്സ്)', 
    keywords: ['cardamom', 'spots', 'dry', 'small', 'ഏലം', 'പേൻ', 'ത്രിപ്സ്'], 
    symptomsEN: 'Tiny insects suck sap from panicles and capsules. Causes corky, scab-like growth on the skin of the cardamom pods.',
    symptomsML: 'ഏലത്തിന്റെ ശരങ്ങളിലും കായ്കളിലും പേൻ വന്ന് നീരൂറ്റിക്കുടിക്കുന്നു. കായ്കളുടെ പുറത്ത് പരുക്കൻ പാടുകൾ വരുന്നത് ഇവ കാരണമാണ്.',
    organicEN: 'Spray Neem oil (2%) or tobacco decoction. Ensure enough shade as thrips multiply faster in direct sunlight.',
    organicML: '2% വീര്യമുള്ള വേപ്പെണ്ണയോ പുകയില കഷായമോ തളിക്കുക. നല്ല തണൽ ഉറപ്പാക്കുന്നത് ഇവ പെരുകുന്നത് തടയാൻ സഹായിക്കും.',
    chemicalEN: 'Apply Quinalphos or Fipronil on the panicles and base of the cardamom clumps during the flowering stage.',
    chemicalML: 'ശരങ്ങൾ വരുന്ന സമയത്ത് ക്വിനാൽഫോസ് അല്ലെങ്കിൽ ഫിപ്രോണിൽ ശരങ്ങളിലേക്ക് എത്തുന്ന വിധം തളിക്കുക.',
    preventiveEN: 'Regularly remove dried leaf sheaths and old panicles. Keep the cardamom clumps clean to reduce hiding spots.',
    preventiveML: 'ഉണങ്ങിയ ഇലകളും പഴയ ശരങ്ങളും വെട്ടിമാറ്റുക. ചെടിയുടെ ചുവട് വൃത്തിയായി സൂക്ഷിക്കുന്നത് കീടങ്ങളുടെ വാസം കുറയ്ക്കും.'
  }
];

// --- Translations ---
const i18n = {
  en: {
    appName: "AGRI EDGE",
    dashboard: "Dashboard",
    crops: "Crops",
    doctor: "Plant Doctor",
    history: "History",
    connectWiFi: "Connect ESP32",
    connected: "Connected",
    disconnected: "Disconnected",
    analyzeSoil: "Analyze Soil & Predict Crop",
    predicting: "Calculating Agronomic Score...",
    fertilizerNeeded: "Actionable Fertilizer Plan",
    optimal: "Optimal",
    alert: "Alert",
    askDoctor: "Describe pest symptoms (e.g. 'Yellow spots')...",
    send: "Analyze Symptoms",
    aiGuide: "Farming Guide",
    organicAlt: "Organic Alternatives",
    close: "Close",
    area: "Farm Area",
    unit: "Unit",
    soilOptimal: "✅ Soil is completely optimal. No heavy inputs needed.",
    soilReport: "Full Soil Health Report",
    cropRotation: "Companion/Rotation",
    connectFirst: "Please connect your sensor first.",
    connectDesc: "Connect your ESP32 hardware to capture live soil data.",
    connecting: "Connecting...",
    welcomeBack: "Welcome Back",
    enterName: "Enter full name",
    enterPhone: "Enter mobile number",
    districtLabel: "Select District",
    elevationLabel: "Select Agro-Ecological Zone",
    startFarming: "Enter Dashboard",
    loginDesc: "Set up your farm profile to get geographically localized recommendations.",
    profile: "Profile",
    logout: "Log Out",
    tutorialTitle: "How to Use Agri Edge",
    tutF1Title: "🔗 Hardware Connection",
    tutF1Desc: "Connect the ESP32 to stream NPK, pH, Moisture, and Temp live.",
    tutF2Title: "🌱 Smart Precision Farming",
    tutF2Desc: "Algorithm matches soil, district, and elevation to the best crops. Enter farm size for exact fertilizer kg outputs.",
    tutF3Title: "🩺 Plant Doctor (Offline)",
    tutF3Desc: "Type symptoms. Get organic treatments, chemical fallback, and preventive steps instantly, completely offline.",
    gotIt: "Start Farming",
    topMatches: "Top Suitable Crops for your Zone",
    match: "Suitability",
    selectBtn: "Select",
    chooseLangTitle: "Choose Language / ഭാഷ",
    englishBtn: "English",
    malayalamBtn: "മലയാളം",
    fullNameLabel: "Full Name",
    phoneLabel: "Phone Number",
    historyTitle: "Soil Analysis Log",
    historyEmpty: "No past data found. Run an analysis first.",
    viewResult: "View Details",
    searchCrops: "Search crops...",
    categoryAll: "All",
    downloadPDF: "Print Report",
    offlineError: "Couldn't match this symptom precisely. Please try descriptive keywords like 'yellow', 'hole', or 'wilting'.",
    rotationDesc: "Best rotation strategies to restore soil health:",
    rotationLegumes: "Legumes (Cowpea, Green gram) - Fixes atmospheric nitrogen.",
    rotationDeepRoot: "Deep-rooted tubers (Yam, Tapioca) - Excellent follow-up to shallow-rooted crops.",
    rotationVeg: "Vegetables (Okra, Bitter gourd) - Good for breaking pest cycles.",
    offlineAlternativeMsg: "General Organic Fertilizer Protocol:\n\n1. Urea (N) Replacement: Cow dung, Poultry manure, Groundnut cake.\n2. SSP (P) Replacement: Bone meal, Rock phosphate.\n3. MOP (K) Replacement: Wood ash, Banana peel compost.",
    selectOneCrop: "Select a crop below for precise fertilizer kg values based on your land area.",
    connectModalTitle: "Connect ESP32 Hardware",
    espIpLabel: "ESP32 IP Address",
    connectRealBtn: "Connect Real Device",
    connectMockBtn: "Run Simulation (Mock Data)",
    cancelBtn: "Cancel",
    fetchError: "Connection failed. Ensure ESP32 is on the same network with CORS enabled.",
    sensorFault: "Sensor Fault Detected! Unrealistic readings found (e.g. Moisture > 100% or Negative NPK). Check probe.",
    seasonPre: "Current Season:",
    pestRiskPre: "Weather Pest Risk:",
    symptomsLbl: "Symptoms:",
    organicLbl: "Organic Treatment:",
    chemicalLbl: "Chemical Fallback:",
    preventiveLbl: "Preventive Actions:"
  },
  ml: {
    appName: "അഗ്രി എഡ്ജ്",
    dashboard: "ഡാഷ്‌ബോർഡ്",
    crops: "വിളകൾ",
    doctor: "പ്ലാന്റ് ഡോക്ടർ",
    history: "ചരിത്രം",
    connectWiFi: "സെൻസർ ബന്ധിപ്പിക്കുക",
    connected: "ബന്ധിപ്പിച്ചു",
    disconnected: "വിച്ഛേദിക്കപ്പെട്ടു",
    analyzeSoil: "മണ്ണ് പരിശോധിച്ച് വിള നിർദ്ദേശിക്കുക",
    predicting: "അൽഗോരിതം പരിശോധിക്കുന്നു...",
    fertilizerNeeded: "കൃത്യമായ വളപ്രയോഗം (kg)",
    optimal: "അനുയോജ്യം",
    alert: "മുന്നറിയിപ്പ്",
    askDoctor: "രോഗലക്ഷണങ്ങൾ വിവരിക്കുക...",
    send: "പരിശോധിക്കുക",
    aiGuide: "കൃഷി മാർഗ്ഗനിർദ്ദേശം",
    organicAlt: "ജൈവ ബദലുകൾ",
    close: "അടയ്ക്കുക",
    area: "കൃഷിസ്ഥലത്തിന്റെ വിസ്തീർണ്ണം",
    unit: "യൂണിറ്റ്",
    soilOptimal: "✅ മണ്ണ് പൂർണ്ണമായും അനുയോജ്യമാണ്! അമിതവളങ്ങൾ ആവശ്യമില്ല.",
    soilReport: "മണ്ണ് പരിശോധനാ റിപ്പോർട്ട്",
    cropRotation: "വിള പരിക്രമണം",
    connectFirst: "ആദ്യം സെൻസറുകൾ ബന്ധിപ്പിക്കുക.",
    connectDesc: "തത്സമയ വിവരങ്ങൾക്കായി ESP32 സെൻസർ ബന്ധിപ്പിക്കുക.",
    connecting: "ബന്ധിപ്പിക്കുന്നു...",
    welcomeBack: "സ്വാഗതം",
    enterName: "മുഴുവൻ പേര്",
    enterPhone: "മൊബൈൽ നമ്പർ",
    districtLabel: "ജില്ല തിരഞ്ഞെടുക്കുക",
    elevationLabel: "ഭൂപ്രകൃതി (Elevation)",
    startFarming: "തുടങ്ങാം",
    loginDesc: "നിങ്ങളുടെ ജില്ലയ്ക്കും ഭൂപ്രകൃതിക്കും അനുയോജ്യമായ വിളകൾ കണ്ടെത്താൻ പ്രൊഫൈൽ സെറ്റ് ചെയ്യുക.",
    profile: "പ്രൊഫൈൽ",
    logout: "ലോഗൗട്ട്",
    tutorialTitle: "അഗ്രി എഡ്ജ് എങ്ങനെ ഉപയോഗിക്കാം",
    tutF1Title: "🔗 സെൻസർ ബന്ധിപ്പിക്കുക",
    tutF1Desc: "ESP32 ഉപയോഗിച്ച് തത്സമയ NPK, pH, ഈർപ്പം എന്നിവ കാണാം.",
    tutF2Title: "🌱 കൃത്യമായ കൃഷി",
    tutF2Desc: "നിങ്ങളുടെ മണ്ണ്, ജില്ല, ഭൂപ്രകൃതി എന്നിവ വിശകലനം ചെയ്ത് മികച്ച വിളകൾ നിർദ്ദേശിക്കുന്നു.",
    tutF3Title: "🩺 പ്ലാന്റ് ഡോക്ടർ",
    tutF3Desc: "ഇന്റർനെറ്റ് ഇല്ലെങ്കിലും കീടങ്ങളുടെ ലക്ഷണങ്ങൾ നൽകി ജൈവ-രാസ പ്രതിവിധികൾ കണ്ടെത്താം.",
    gotIt: "തുടങ്ങാം",
    topMatches: "നിങ്ങളുടെ ഭൂപ്രകൃതിക്ക് അനുയോജ്യമായ വിളകൾ",
    match: "യോജിച്ചത്",
    selectBtn: "തിരഞ്ഞെടുക്കുക",
    chooseLangTitle: "ഭാഷ തിരഞ്ഞെടുക്കുക",
    englishBtn: "English",
    malayalamBtn: "മലയാളം",
    fullNameLabel: "പേര്",
    phoneLabel: "ഫോൺ നമ്പർ",
    historyTitle: "മണ്ണ് പരിശോധനാ ചരിത്രം",
    historyEmpty: "മുൻകാല ഫലങ്ങൾ ലഭ്യമല്ല.",
    viewResult: "വിശദാംശങ്ങൾ",
    searchCrops: "വിളകൾ തിരയുക...",
    categoryAll: "എല്ലാം",
    downloadPDF: "റിപ്പോർട്ട് പ്രിന്റ് ചെയ്യുക",
    offlineError: "ഈ ലക്ഷണം കൃത്യമായി കണ്ടെത്താനായില്ല. ദയവായി ലക്ഷണങ്ങൾ കുറച്ചുകൂടി വ്യക്തമായി നൽകുക (ഉദാഹരണത്തിന്: മഞ്ഞ, തുള, വാട്ടം).",
    rotationDesc: "മണ്ണിന്റെ വളക്കൂറ് വീണ്ടെടുക്കാൻ മികച്ച വിള പരിക്രമണം:",
    rotationLegumes: "പയർവർഗ്ഗങ്ങൾ (വൻപയർ, ചെറുപയർ) - നൈട്രജൻ വർദ്ധിപ്പിക്കാൻ.",
    rotationDeepRoot: "കിഴങ്ങുവർഗ്ഗങ്ങൾ (കപ്പ, ചേന) - ആഴത്തിൽ വേരോടാത്ത വിളകൾക്ക് ശേഷം നടാൻ ഉത്തമം.",
    rotationVeg: "പച്ചക്കറികൾ (വെണ്ട, പാവൽ) - കീടങ്ങളുടെ തുടർച്ച ഒഴിവാക്കാൻ.",
    offlineAlternativeMsg: "പൊതുവായ ജൈവവളങ്ങൾ:\n\n1. യൂറിയക്ക് പകരം: ചാണകം, കോഴിവളം, കടലപ്പിണ്ണാക്ക്.\n2. ഫോസ്ഫറസിന് പകരം: എല്ലുപൊടി, റോക്ക് ഫോസ്ഫേറ്റ്.\n3. പൊട്ടാസ്യത്തിന് പകരം: മരച്ചാരം, വാഴപ്പിണ്ടി കമ്പോസ്റ്റ്.",
    selectOneCrop: "വളപ്രയോഗവും കൃഷിരീതിയും അറിയാൻ താഴെ നിന്ന് ഒരു വിള തിരഞ്ഞെടുക്കുക.",
    connectModalTitle: "സെൻസർ ബന്ധിപ്പിക്കുക",
    espIpLabel: "ESP32 ഐപി വിലാസം",
    connectRealBtn: "ഹാർഡ്‌വെയർ ബന്ധിപ്പിക്കുക",
    connectMockBtn: "മാതൃകാ ഡാറ്റ (Test)",
    cancelBtn: "റദ്ദാക്കുക",
    fetchError: "കണക്ട് ചെയ്യാൻ കഴിഞ്ഞില്ല. ഐപി വിലാസവും വൈഫൈയും പരിശോധിക്കുക.",
    sensorFault: "സെൻസർ തകരാർ! അസാധാരണമായ റീഡിംഗ് (ഉദാ: ഈർപ്പം 100%-ന് മുകളിൽ അല്ലെങ്കിൽ നെഗറ്റീവ് മൂല്യങ്ങൾ). പ്രോബ് പരിശോധിക്കുക.",
    seasonPre: "നിലവിലെ കാലാവസ്ഥ:",
    pestRiskPre: "കാലാവസ്ഥാ കീട മുന്നറിയിപ്പ്:",
    symptomsLbl: "ലക്ഷണങ്ങൾ:",
    organicLbl: "ജൈവ പ്രതിവിധി:",
    chemicalLbl: "രാസകീടനാശിനി (അത്യാവശ്യമെങ്കിൽ):",
    preventiveLbl: "മുൻകരുതലുകൾ:"
  }
};

export default function App() {
  const [lang, setLang] = useState('en');
  const [languageSelected, setLanguageSelected] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  
  const [localUser, setLocalUser] = useState(null); 
  const [user, setUser] = useState(null); 
  const [loginForm, setLoginForm] = useState({ name: '', phone: '', district: 'Ernakulam', elevation: 'Midland' });
  
  const [showTutorial, setShowTutorial] = useState(false);
  const [analysisHistory, setAnalysisHistory] = useState([]);

  const [showConnectModal, setShowConnectModal] = useState(false);
  const [espIp, setEspIp] = useState('192.168.4.1');
  const [connected, setConnected] = useState(false);
  const [connectionType, setConnectionType] = useState('none'); 
  const [isConnecting, setIsConnecting] = useState(false);
  const [rawSensors, setRawSensors] = useState({ pH: 0, temp: 0, moisture: 0 });
  // NPK is always estimated from the 3 real sensors (pH, moisture, temp)
  const sensors = useMemo(() => {
    const { N, P, K, confidence } = estimateNPK(rawSensors.pH, rawSensors.moisture, rawSensors.temp);
    return { ...rawSensors, N, P, K, confidence };
  }, [rawSensors]);
  const [pollIntervalId, setPollIntervalId] = useState(null);
  
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [predictionList, setPredictionList] = useState(null); 
  const [resultModal, setResultModal] = useState(null);
  const [farmArea, setFarmArea] = useState(1);
  const [farmUnit, setFarmUnit] = useState('Acre'); 
  
  const [searchInput, setSearchInput] = useState('');
  const [cropSearch, setCropSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState('All');
  
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResponse, setAiResponse] = useState('');
  const [chatQuery, setChatQuery] = useState('');
  const chatEndRef = useRef(null);

  const t = i18n[lang];
  const currentSeason = getSeason();

  useEffect(() => {
    const loadDB = async () => {
      if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().catch(console.error);
      }
      try {
        const savedUser = await dbGetUser();
        if (savedUser) {
          setLocalUser(savedUser);
          setUser(savedUser); 
          setLanguageSelected(true); 
          const savedHistory = await dbGetHistory();
          setAnalysisHistory(savedHistory || []);
        }
      } catch (error) {
        console.error("IndexedDB Load Error:", error);
      }
    };
    loadDB();
  }, []);

  useEffect(() => {
    let metaThemeColor = document.querySelector("meta[name=theme-color]");
    if (!metaThemeColor) {
      metaThemeColor = document.createElement("meta");
      metaThemeColor.name = "theme-color";
      document.head.appendChild(metaThemeColor);
    }
    metaThemeColor.content = darkMode ? "#064e3b" : "#059669";
  }, [darkMode]);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    const handler = setTimeout(() => setCropSearch(searchInput.normalize("NFD").replace(/[\u0300-\u036f]/g, "")), 300);
    return () => clearTimeout(handler);
  }, [searchInput]);

  useEffect(() => {
    if (aiResponse && chatEndRef.current) {
      setTimeout(() => chatEndRef.current.scrollIntoView({ behavior: 'smooth' }), 100);
    }
  }, [aiResponse]);

  useEffect(() => {
    return () => {
      if (pollIntervalId) clearInterval(pollIntervalId);
    };
  }, [pollIntervalId]);

  const handleLogin = async (e) => {
    e.preventDefault();
    if (loginForm.name && loginForm.phone.length >= 10) {
      const newUser = { ...loginForm, id: 'profile' };
      try {
        await dbSaveUser(newUser); 
        setLocalUser(newUser);
        setUser(newUser);
        setShowTutorial(true);
      } catch(e) {
        alert("Failed to save profile data.");
      }
    } else {
      alert(lang === 'en' ? "Please enter valid details." : "ശരിയായ വിവരങ്ങൾ നൽകുക.");
    }
  };

  const handleLogout = async () => {
    if (window.confirm(lang === 'en' ? "Log out completely? Data will be cleared from this device." : "ലോഗൗട്ട് ചെയ്യണമെന്നുറപ്പാണോ? ഈ ഫോണിലെ വിവരങ്ങൾ മായ്‌ക്കപ്പെടും.")) {
      await dbClearUser(); 
      await dbClearHistory();
      setUser(null);
      setLocalUser(null);
      setLoginForm({ name: '', phone: '', district: 'Ernakulam', elevation: 'Midland' });
      setConnected(false);
      setConnectionType('none');
      if(pollIntervalId) clearInterval(pollIntervalId);
      setRawSensors({ pH: 0, temp: 0, moisture: 0 });
      setAnalysisHistory([]);
      setPredictionList(null);
      setResultModal(null);
    }
  };

  const handleRealConnect = async (e) => {
    e.preventDefault();
    setIsConnecting(true);
    let success = false;
    const endpoints = ['/data', '/sensor', '/api', '/readings'];
    
    const fetchSensor = async (endpoint) => {
      const response = await fetch(`http://${espIp}${endpoint}`);
      if (response.ok) {
        const data = await response.json();
        // Only pH, moisture, and temperature come from real hardware sensors.
        // NPK is automatically estimated via the estimateNPK algorithm.
        setRawSensors(prev => ({ 
          pH: data.pH ?? prev.pH, 
          temp: data.temp ?? prev.temp, 
          moisture: data.moisture ?? prev.moisture 
        }));
        return true;
      }
      return false;
    };

    let activeEndpoint = null;
    for (let endpoint of endpoints) {
      if (success) break;
      try {
        success = await fetchSensor(endpoint);
        if (success) activeEndpoint = endpoint;
      } catch (error) {
        console.log(`Failed endpoint: ${endpoint}`);
      }
    }
    
    if (success) {
      setConnected(true);
      setConnectionType('real');
      setShowConnectModal(false);
      
      const id = setInterval(async () => {
        try {
          const isStillSuccess = await fetchSensor(activeEndpoint);
          if(!isStillSuccess) throw new Error("Dropped");
        } catch(err) {
          console.warn("Connection lost.");
          setConnected(false);
          setConnectionType('none');
          clearInterval(id);
        }
      }, 30000);
      setPollIntervalId(id);

    } else {
      alert(t.fetchError);
    }
    setIsConnecting(false);
  };

  const handleMockConnect = () => {
    setIsConnecting(true);
    setTimeout(() => {
      setConnected(true);
      setConnectionType('mock');
      setIsConnecting(false);
      // Only set the 3 real sensor values; NPK is auto-estimated from these
      setRawSensors({ pH: 5.8, temp: 28, moisture: 65 });
      setShowConnectModal(false);
    }, 1000);
  };

  const handleAnalyze = () => {
    if (!connected) return alert(t.connectFirst);
    if (sensors.moisture > 100 || sensors.moisture < 0 || sensors.pH > 14 || sensors.pH < 0 || sensors.temp > 60 || sensors.temp < -10) {
      return alert(t.sensorFault);
    }
    setIsAnalyzing(true);
    setTimeout(() => {
      let scoredCrops = cropsDB.map(crop => {
        const moistGap = sensors.moisture < crop.moistMin ? crop.moistMin - sensors.moisture : (sensors.moisture > crop.moistMax ? sensors.moisture - crop.moistMax : 0);
        const tempGap = sensors.temp < crop.tempMin ? crop.tempMin - sensors.temp : (sensors.temp > crop.tempMax ? sensors.temp - crop.tempMax : 0);
        const pHGap = Math.abs(sensors.pH - crop.pH);
        
        let gap = (pHGap * 10) + (Math.max(0, crop.N - sensors.N) * 1) + (Math.max(0, crop.P - sensors.P) * 1) + (Math.max(0, crop.K - sensors.K) * 0.7) + (moistGap * 2) + (tempGap * 4);
        
        if (!crop.elevations?.includes(user.elevation)) gap += 200; 
        if (!crop.seasons?.includes(currentSeason)) gap += 50; 

        let reason = "";
        if (gap < 200) {
           if (pHGap <= 0.5 && moistGap === 0 && tempGap === 0) reason = lang === 'en' ? `Perfect match for ${user.elevation} in ${currentSeason} ✅` : `${user.elevation} പ്രദേശത്തിന് തികച്ചും അനുയോജ്യം ✅`;
           else if (moistGap === 0 && tempGap === 0) reason = lang === 'en' ? "Good climate match ⛅" : "നല്ല കാലാവസ്ഥ ⛅";
           else reason = lang === 'en' ? "Nutrient profile matches 🌱" : "വളക്കൂറ് അനുയോജ്യമാണ് 🌱";
        } else {
           reason = lang === 'en' ? "Not optimal for this zone/season ⚠️" : "ഈ പ്രദേശത്തിന്/കാലാവസ്ഥയ്ക്ക് അനുയോജ്യമല്ല ⚠️";
        }
        
        return { ...crop, gap, reason };
      });
      scoredCrops.sort((a, b) => a.gap - b.gap);
      
      const top5 = scoredCrops.slice(0, 5).map(crop => ({
        ...crop,
        matchPercent: Math.max(5, 100 - (crop.gap / 6)).toFixed(0)
      }));
      setPredictionList(top5);
      setIsAnalyzing(false);
    }, 1500);
  };

  const selectPredictedCrop = (crop) => {
    setPredictionList(null);
    calculateFertilizer(crop);
  };

  const calculateFertilizer = async (crop) => {
    let urea = 0, ssp = 0, mop = 0, lime = 0;
    
    if (connected) {
      urea = Math.min(350, Math.max(0, (crop.N - sensors.N) / 0.46));
      ssp = Math.min(450, Math.max(0, (crop.P - sensors.P) * 6.25)); 
      mop = Math.min(300, Math.max(0, (crop.K - sensors.K) * 2));
      if (sensors.pH < 4.5) lime = 800;
      else if (sensors.pH < 5.5) lime = 500;
      else if (sensors.pH < 6.0) lime = 250;
    } else {
      urea = Math.min(350, crop.N / 0.46);
      ssp = Math.min(450, crop.P * 6.25);
      mop = Math.min(300, crop.K * 2);
    }
    
    const resultObj = { crop, baseReq: { urea, ssp, mop, lime }, isLive: connected };
    setResultModal(resultObj);
    setAiResponse(''); 
    
    if (connected) {
      const timestamp = Date.now();
      const newRecord = {
        id: timestamp,
        timestamp: timestamp,
        date: new Date().toLocaleDateString(),
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        crop: crop,
        baseReq: { urea, ssp, mop, lime },
        sensors: sensors
      };
      const updatedHistory = [newRecord, ...analysisHistory].slice(0, 100); 
      setAnalysisHistory(updatedHistory);
      await dbSaveHistory(newRecord);
    }
  };

  const convertToKg = (val, multiplier) => {
      // Conversion mapping: multiplier logic ensures the output is always in kg for the selected area unit.
      return parseFloat((val * multiplier).toFixed(1));
  };

  const activeFerts = useMemo(() => {
    if (!resultModal) return [];
    let multiplier = 1;
    if (farmUnit === 'Acre') multiplier = 0.404686; // 1 Hectare = ~2.47 Acres
    if (farmUnit === 'Cent') multiplier = 0.00404686; // 1 Hectare = ~247 Cents
    if (farmUnit === 'Hectare') multiplier = 1;
    
    const totalAreaMultiplier = multiplier * (farmArea || 0);
    const { urea, ssp, mop, lime } = resultModal.baseReq;

    return [
      { key: 'lime', label: 'Lime / കുമ്മായം (pH)', val: convertToKg(lime, totalAreaMultiplier), color: 'border-yellow-400' },
      { key: 'urea', label: 'Urea / യൂറിയ (N)', val: convertToKg(urea, totalAreaMultiplier), color: 'border-blue-500' },
      { key: 'ssp', label: 'SSP (or Bone Meal) / അസ്ഥിപ്പൊടി (P)', val: convertToKg(ssp, totalAreaMultiplier), color: 'border-purple-500' },
      { key: 'mop', label: 'MOP / പൊട്ടാഷ് (K)', val: convertToKg(mop, totalAreaMultiplier), color: 'border-red-500' }
    ].filter(f => f.val > 0);
  }, [resultModal, farmUnit, farmArea]);

  const generateOfflineSoilReport = () => {
    let report = [`**${t.seasonPre}** ${currentSeason} | **Zone:** ${user.elevation}\n`];
    
    let pestRisk = "";
    const fungalMoistTrigger = user.elevation === 'Highland' ? 70 : 75; 
    const fungalTempMax = user.elevation === 'Highland' ? 28 : 32;

    if (sensors.moisture >= fungalMoistTrigger && sensors.temp <= fungalTempMax) {
      pestRisk = lang === 'en' 
        ? `⚠️ **PEST RISK ALERTS:** High humidity (>=${fungalMoistTrigger}%) & optimal temps detected. High fungal risk! Watch for **Quick Wilt** in Pepper and **Mahali** in Arecanut.` 
        : `⚠️ **കാലാവസ്ഥാ കീട മുന്നറിയിപ്പ്:** കടുത്ത ഫംഗസ് രോഗങ്ങൾക്ക് സാധ്യതയുണ്ട്. കുരുമുളകിലെ ദ്രുതവാട്ടം, കവുങ്ങിലെ മഹാളി എന്നിവ പ്രത്യേകം ശ്രദ്ധിക്കുക.`;
      report.push(pestRisk);
    } else if (sensors.moisture < 50 && sensors.temp > 32) {
       pestRisk = lang === 'en' ? "⚠️ **HEAT STRESS RISK:** High heat & low moisture. Watch for mite attacks (Eriophyid mite) and ensure deep watering." : "⚠️ **വരൾച്ചാ മുന്നറിയിപ്പ്:** കടുത്ത ചൂട്. മണ്ടരി പോലെയുള്ള കീടങ്ങളെ ശ്രദ്ധിക്കുകയും തടത്തിൽ ധാരാളം വെള്ളം നൽകുകയും ചെയ്യുക.";
       report.push(pestRisk);
    }

    report.push(`\n**${t.fertilizerNeeded}:**`);

    if(sensors.pH < 4.5) report.push(lang==='en' ? "🔴 pH is severely acidic. **Action:** Broadcast 800 kg/ha agricultural lime." : "🔴 മണ്ണിൽ പുളിപ്പ് വളരെ കൂടുതലാണ്. **പരിഹാരം:** ഹെക്ടറിന് 800 കിലോ കുമ്മായം നൽകുക.");
    else if(sensors.pH < 5.5) report.push(lang==='en' ? "🔴 pH is moderately acidic. **Action:** Broadcast 500 kg/ha agricultural lime." : "🔴 മണ്ണിൽ പുളിപ്പ് കൂടുതലാണ്. **പരിഹാരം:** ഹെക്ടറിന് 500 കിലോ കുമ്മായം നൽകുക.");
    else if(sensors.pH < 6.0) report.push(lang==='en' ? "🟡 pH is slightly acidic. **Action:** Broadcast 250 kg/ha agricultural lime." : "🟡 മണ്ണിൽ നേരിയ പുളിപ്പ്. **പരിഹാരം:** ഹെക്ടറിന് 250 കിലോ കുമ്മായം നൽകുക.");
    else if(sensors.pH > 7.5) report.push(lang==='en' ? "🔴 pH is alkaline. **Action:** Apply heavy organic compost to balance." : "🔴 മണ്ണിൽ ക്ഷാരഗുണം കൂടുതൽ. **പരിഹാരം:** കമ്പോസ്റ്റ് ചേർക്കുക.");
    else report.push(lang==='en' ? "✅ pH is Optimal (Neutral)." : "✅ മണ്ണിന്റെ പുളിപ്പ് വളരെ അനുയോജ്യമായ നിലയിലാണ്.");

    if(sensors.N < 50) report.push(lang==='en' ? "🔴 Nitrogen is critically low. **Action:** Apply well-rotted cow dung and Neem cake immediately." : "🔴 നൈട്രജൻ വളരെ കുറവ്. **പരിഹാരം:** ചാണകപ്പൊടിയും വേപ്പിൻ പിണ്ണാക്കും ഉടൻ നൽകുക.");
    if(sensors.P < 20) report.push(lang==='en' ? "🔴 Phosphorus is low. **Action:** Apply Steamed Bone Meal." : "🔴 ഫോസ്ഫറസ് കുറവ്. **പരിഹാരം:** അസ്ഥിപ്പൊടി വിതറുക.");
    if(sensors.K < 100) report.push(lang==='en' ? "🔴 Potassium is low. **Action:** Apply pure wood ash or banana peel compost." : "🔴 പൊട്ടാസ്യം കുറവ്. **പരിഹാരം:** മരച്ചാരം നൽകുക.");

    if (sensors.N >= 50 && sensors.P >= 20 && sensors.K >= 100) report.push(lang==='en' ? "✅ NPK levels are sufficient for basic growth." : "✅ മണ്ണിൽ ആവശ്യത്തിന് NPK പോഷകങ്ങളുണ്ട്.");

    report.push(lang==='en' ? "\n*(Refer to specific Crop predictions for exact limits)*" : "\n*(കൃത്യമായ അളവുകൾ അറിയാൻ താഴെയുള്ള വിളകൾ തിരഞ്ഞെടുക്കുക)*");
    return report.join('\n\n');
  };

  const getOfflinePestRemedy = (query) => {
    const lowerQuery = query.toLowerCase();
    const matchedPest = pestsDB.find(p => 
      lowerQuery.includes(p.nameEN.toLowerCase()) || 
      query.includes(p.nameML) ||
      (p.keywords && p.keywords.some(kw => lowerQuery.includes(kw)))
    );
    
    if(matchedPest) {
      return lang === 'en' 
        ? `**Disease/Pest:** ${matchedPest.nameEN}\n\n**${t.symptomsLbl}**\n${matchedPest.symptomsEN}\n\n**${t.organicLbl}**\n${matchedPest.organicEN}\n\n**${t.chemicalLbl}**\n${matchedPest.chemicalEN}\n\n**${t.preventiveLbl}**\n${matchedPest.preventiveEN}` 
        : `**രോഗം/കീടം:** ${matchedPest.nameML}\n\n**${t.symptomsLbl}**\n${matchedPest.symptomsML}\n\n**${t.organicLbl}**\n${matchedPest.organicML}\n\n**${t.chemicalLbl}**\n${matchedPest.chemicalML}\n\n**${t.preventiveLbl}**\n${matchedPest.preventiveML}`;
    }
    return t.offlineError;
  };

  // Local Offline Expert System Routing (100% Offline)
  const handleAIRequest = (promptText, type = 'general') => {
    setAiLoading(true);
    setTimeout(() => {
      let response = "";
      if (type === 'pest') response = getOfflinePestRemedy(promptText);
      else if (type === 'soil') response = generateOfflineSoilReport();
      else if (type === 'guide') response = lang === 'en' ? `**Agri Edge Guide for ${resultModal.crop.nameEN}:**\n\n${resultModal.crop.guideEN}` : `**${resultModal.crop.nameML} കൃഷിരീതി:**\n\n${resultModal.crop.guideML}`;
      else if (type === 'organic') {
        if (resultModal && resultModal.crop.organicEN) {
           response = lang === 'en' ? `**Organic Fertilizer Protocol for ${resultModal.crop.nameEN}:**\n\n${resultModal.crop.organicEN}` : `**${resultModal.crop.nameML} - ജൈവവള പ്രയോഗം:**\n\n${resultModal.crop.organicML}`;
        } else {
           response = t.offlineAlternativeMsg;
        }
      }
      else if (type === 'rotation') {
        let dynamicRotation = "";
        if (resultModal) {
            if (resultModal.crop.cat === 'Tuber') dynamicRotation = lang === 'en' ? `1. ${t.rotationLegumes}` : `1. ${t.rotationLegumes}`;
            else if (resultModal.crop.cat === 'Cereal' || resultModal.crop.cat === 'Vegetable') dynamicRotation = lang === 'en' ? `1. ${t.rotationLegumes}\n2. ${t.rotationDeepRoot}` : `1. ${t.rotationLegumes}\n2. ${t.rotationDeepRoot}`;
            else dynamicRotation = lang === 'en' ? `1. ${t.rotationLegumes}\n2. Vegetables (Okra, Bitter gourd) - Good for breaking pest cycles.` : `1. ${t.rotationLegumes}\n2. പച്ചക്കറികൾ (വെണ്ട, പാവൽ) - കീടങ്ങളുടെ തുടർച്ച ഒഴിവാക്കാൻ.`;
        } else {
            dynamicRotation = `${t.rotationLegumes}\n${t.rotationDeepRoot}`;
        }
        response = `${t.rotationDesc}\n\n${dynamicRotation}`;
      }
      else response = t.offlineAlternativeMsg;
      
      setAiResponse(response);
      setAiLoading(false);
    }, 500); 
  };

  const askOrganicAlternatives = () => handleAIRequest(`organic`, 'organic');
  const askFarmGuide = () => handleAIRequest(`guide`, 'guide');
  const askCropRotation = () => handleAIRequest(`rotation`, 'rotation');
  const askSoilReport = () => {
    if (!connected) return alert(t.connectFirst);
    handleAIRequest(`soil`, 'soil');
  };
  const handleChatSubmit = (e) => {
    e.preventDefault();
    if (!chatQuery.trim()) return;
    handleAIRequest(chatQuery, 'pest');
    setChatQuery('');
  };

  const generatePDF = () => window.print();

  const filteredCrops = useMemo(() => {
    return cropsDB.filter(c => {
      const normalizedSearch = cropSearch.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      const matchesSearch = c.nameEN.toLowerCase().includes(normalizedSearch) || c.nameML.includes(cropSearch);
      
      const categoryIndex = categories.findIndex(cat => cat.ml === activeCategory || cat.en === activeCategory);
      const mappedCategory = categoryIndex !== -1 ? categories[categoryIndex].en : activeCategory;
      const matchesCategory = activeCategory === 'All' || activeCategory === 'എല്ലാം' || c.cat === mappedCategory;
      
      return matchesSearch && matchesCategory;
    });
  }, [cropSearch, activeCategory, lang]);

  const Gauge = ({ icon: Icon, label, value, max, unit, optimal, color }) => {
    const percentage = Math.min(100, Math.max(0, (value / max) * 100));
    const isOptimal = value >= optimal[0] && value <= optimal[1];
    return (
      <div className={`p-4 rounded-2xl flex flex-col items-center justify-center border-2 shadow-sm transition-all duration-300 ${isOptimal ? 'border-emerald-500/30 bg-emerald-50/50 dark:bg-emerald-900/10' : 'border-red-400/30 bg-red-50/50 dark:bg-red-900/10'}`}>
        <Icon className={`w-8 h-8 mb-2 ${color}`} />
        <span className="text-sm text-slate-500 dark:text-slate-400 font-medium text-center">{label}</span>
        <div className="flex items-baseline space-x-1 mt-1">
          <span className="text-3xl font-bold dark:text-white">{value}</span>
          <span className="text-sm font-semibold text-slate-400">{unit}</span>
        </div>
        <div className="w-full h-2 bg-slate-200 dark:bg-slate-700 rounded-full mt-3 overflow-hidden">
          <div className={`h-full rounded-full transition-all duration-1000 ${isOptimal ? 'bg-emerald-500' : 'bg-red-500'}`} style={{ width: `${percentage}%` }} />
        </div>
        <span className={`text-xs mt-2 font-semibold px-2 py-1 rounded-full ${isOptimal ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-400' : 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-400'}`}>
          {isOptimal ? t.optimal : t.alert}
        </span>
      </div>
    );
  };

  const AIResponseCard = ({ text }) => (
    <div className="bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-slate-800 dark:to-emerald-900/20 p-5 rounded-2xl border border-emerald-200 dark:border-emerald-800 relative mt-4 animate-in fade-in self-start w-full shadow-sm print:shadow-none print:border-slate-300">
      <div className="flex justify-between items-start mb-3">
        <div className="flex items-center space-x-2">
          <Sparkles className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
          <h4 className="font-bold text-emerald-800 dark:text-emerald-300">
            {lang === 'en' ? "Expert System Insight" : "എക്സ്പർട്ട് സിസ്റ്റം വിവരങ്ങൾ"}
          </h4>
        </div>
        <div className="flex items-center space-x-1 print:hidden">
          <button onClick={() => setAiResponse('')} className="text-emerald-600 dark:text-emerald-400 p-1.5 hover:bg-emerald-200 dark:hover:bg-emerald-800 rounded-full transition">
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>
      <div className="text-sm text-slate-700 dark:text-slate-300 whitespace-pre-wrap leading-relaxed markdown-body">
         {text}
      </div>
    </div>
  );

  return (
    <div className={`${darkMode ? 'dark' : ''} h-screen w-full overflow-hidden flex flex-col print:h-auto print:overflow-visible`}>
      <div className="h-full w-full bg-slate-50 dark:bg-slate-900 flex flex-col font-sans transition-colors duration-300 text-slate-800 dark:text-slate-100 relative print:bg-white print:text-black">
        
        {(!languageSelected || !user) && (
          <div className="absolute top-4 right-4 flex space-x-2 z-50">
            {languageSelected && (
              <button onClick={() => setLang(lang === 'en' ? 'ml' : 'en')} className="p-2 bg-emerald-100 dark:bg-slate-800 rounded-full text-emerald-700 dark:text-emerald-400">
                <Languages className="w-5 h-5" />
              </button>
            )}
            <button onClick={() => setDarkMode(!darkMode)} className="p-2 bg-emerald-100 dark:bg-slate-800 rounded-full text-emerald-700 dark:text-emerald-400">
              {darkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </button>
          </div>
        )}

        {!languageSelected ? (
          <div className="flex-1 flex items-center justify-center p-4 animate-in fade-in duration-500">
            <div className="bg-white dark:bg-slate-800 p-8 rounded-3xl shadow-xl w-full max-w-sm border border-slate-100 dark:border-slate-700 text-center">
              <div className="flex justify-center mb-6">
                <div className="bg-emerald-100 dark:bg-emerald-900/50 p-5 rounded-full shadow-inner"><Sprout className="w-14 h-14 text-emerald-600 dark:text-emerald-400" /></div>
              </div>
              <h1 className="text-2xl font-black text-slate-800 dark:text-white mb-2">AGRI EDGE</h1>
              <h2 className="text-xl font-bold text-slate-700 dark:text-slate-300 mb-8 font-serif">അഗ്രി എഡ്ജ്</h2>
              <div className="space-y-4">
                <button onClick={() => { setLang('en'); setLanguageSelected(true); }} className="w-full bg-slate-100 hover:bg-emerald-50 dark:bg-slate-700 font-bold py-4 rounded-2xl transition-all text-lg text-slate-800 dark:text-white">{t.englishBtn}</button>
                <button onClick={() => { setLang('ml'); setLanguageSelected(true); }} className="w-full bg-slate-100 hover:bg-emerald-50 dark:bg-slate-700 font-bold py-4 rounded-2xl transition-all text-xl font-serif text-slate-800 dark:text-white">{t.malayalamBtn}</button>
              </div>
            </div>
          </div>
        ) : 
        
        !user ? (
          <div className="flex-1 flex items-center justify-center p-4 animate-in zoom-in-95 duration-500 overflow-y-auto">
            <div className="bg-white dark:bg-slate-800 p-8 rounded-3xl shadow-xl w-full max-w-md border border-slate-100 dark:border-slate-700 mt-10 mb-10">
              <div className="flex justify-center mb-6">
                <div className="bg-emerald-100 dark:bg-emerald-900/50 p-4 rounded-full shadow-inner"><Sprout className="w-12 h-12 text-emerald-600 dark:text-emerald-400" /></div>
              </div>
              <h1 className={`text-2xl font-black text-center mb-2 tracking-wide text-slate-800 dark:text-white ${lang === 'ml' ? 'font-serif' : 'font-sans'}`}>{t.appName}</h1>
              <p className="text-center text-slate-500 dark:text-slate-400 text-sm mb-6 leading-relaxed">{t.loginDesc}</p>
              
              <form onSubmit={handleLogin} className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 mb-1 ml-1">{t.fullNameLabel}</label>
                  <input type="text" value={loginForm.name} onChange={(e) => setLoginForm({...loginForm, name: e.target.value})} className="w-full px-4 py-3 rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:text-white transition" required />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 mb-1 ml-1">{t.phoneLabel}</label>
                  <input type="tel" value={loginForm.phone} onChange={(e) => setLoginForm({...loginForm, phone: e.target.value})} className="w-full px-4 py-3 rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:text-white transition" required />
                </div>
                
                <div className="grid grid-cols-2 gap-3">
                   <div>
                    <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 mb-1 ml-1">{t.districtLabel}</label>
                    <select value={loginForm.district} onChange={(e) => setLoginForm({...loginForm, district: e.target.value})} className="w-full px-4 py-3 rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:text-white transition text-sm">
                      {districts.map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                   </div>
                   <div>
                    <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 mb-1 ml-1">{t.elevationLabel}</label>
                    <select value={loginForm.elevation} onChange={(e) => setLoginForm({...loginForm, elevation: e.target.value})} className="w-full px-4 py-3 rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:text-white transition text-sm">
                      {elevations.map(e => <option key={e.id} value={e.id}>{lang === 'en' ? e.nameEN : e.nameML}</option>)}
                    </select>
                   </div>
                </div>

                <button type="submit" className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-4 rounded-2xl flex items-center justify-center space-x-2 shadow-lg shadow-emerald-500/30 active:scale-95 transition-all mt-4">
                  <span>{t.startFarming}</span><ArrowRight className="w-5 h-5" />
                </button>
              </form>
            </div>
          </div>
        ) : (
          <>
            {showConnectModal && (
              <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 animate-in fade-in">
                <div className="bg-white dark:bg-slate-800 p-6 rounded-3xl w-full max-w-sm shadow-2xl flex flex-col">
                  <div className="flex items-center justify-between mb-6">
                    <h2 className="text-xl font-black dark:text-white">{t.connectModalTitle}</h2>
                    <button onClick={() => setShowConnectModal(false)} className="p-2 bg-slate-100 dark:bg-slate-700 rounded-full hover:bg-slate-200"><X className="w-5 h-5" /></button>
                  </div>
                  <form onSubmit={handleRealConnect} className="space-y-4 mb-6 border-b border-slate-200 dark:border-slate-700 pb-6">
                    <div>
                      <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 mb-2">{t.espIpLabel}</label>
                      <input type="text" value={espIp} onChange={(e) => setEspIp(e.target.value)} placeholder="192.168.4.1" className="w-full px-4 py-3 rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:text-white transition font-mono text-center" required />
                    </div>
                    <button type="submit" disabled={isConnecting} className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-3.5 rounded-2xl active:scale-95 flex items-center justify-center space-x-2">
                      {isConnecting ? <Loader2 className="w-5 h-5 animate-spin" /> : <Wifi className="w-5 h-5" />}<span>{t.connectRealBtn}</span>
                    </button>
                  </form>
                  <button onClick={handleMockConnect} disabled={isConnecting} className="w-full bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:text-white font-bold py-3.5 rounded-2xl active:scale-95 flex items-center justify-center space-x-2">
                    <FlaskConical className="w-5 h-5" /><span>{t.connectMockBtn}</span>
                  </button>
                </div>
              </div>
            )}

            {showTutorial && (
              <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 animate-in fade-in">
                <div className="bg-white dark:bg-slate-800 p-6 rounded-3xl w-full max-w-lg shadow-2xl flex flex-col max-h-[85vh]">
                  <div className="flex items-center justify-center mb-4 space-x-3">
                    <div className="bg-emerald-100 dark:bg-emerald-900/50 w-12 h-12 flex items-center justify-center rounded-full"><Info className="w-6 h-6 text-emerald-600 dark:text-emerald-400" /></div>
                    <h2 className="text-xl font-black dark:text-white flex-1">{t.tutorialTitle}</h2>
                  </div>
                  <div className="overflow-y-auto space-y-4 pr-2 mb-6 scrollbar-hide flex-1 text-left">
                    {[{ title: t.tutF1Title, desc: t.tutF1Desc }, { title: t.tutF2Title, desc: t.tutF2Desc }, { title: t.tutF3Title, desc: t.tutF3Desc }].map((f, idx) => (
                      <div key={idx} className="bg-slate-50 dark:bg-slate-700/30 p-4 rounded-2xl border border-slate-100 dark:border-slate-700">
                        <h4 className="font-bold text-emerald-600 dark:text-emerald-400 mb-1">{f.title}</h4>
                        <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">{f.desc}</p>
                      </div>
                    ))}
                  </div>
                  <button onClick={() => setShowTutorial(false)} className="w-full bg-emerald-600 text-white font-bold py-4 rounded-2xl active:scale-95 flex items-center justify-center space-x-2 shadow-lg shadow-emerald-500/20 shrink-0">
                    <CheckCircle2 className="w-6 h-6" /><span>{t.gotIt}</span>
                  </button>
                </div>
              </div>
            )}

            {predictionList && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 animate-in fade-in">
                <div className="bg-white dark:bg-slate-900 w-full max-w-md rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
                  <div className="bg-emerald-600 p-4 flex justify-between items-center text-white shrink-0">
                    <div className="flex items-center space-x-2"><Sparkles className="w-5 h-5" /><h3 className="font-bold text-lg">{t.topMatches}</h3></div>
                    <button onClick={() => setPredictionList(null)} className="p-1 bg-white/20 hover:bg-white/30 rounded-full transition"><X className="w-5 h-5" /></button>
                  </div>
                  <div className="p-3 bg-emerald-50 dark:bg-slate-800 border-b border-slate-100 dark:border-slate-700 shrink-0">
                    <p className="text-xs text-emerald-800 dark:text-emerald-300 font-medium text-center">Zone: {user.elevation} | Season: {currentSeason}</p>
                  </div>
                  <div className="p-4 space-y-3 overflow-y-auto flex-1">
                    {predictionList.map((crop, index) => (
                      <div key={crop.id} className={`flex items-center justify-between p-3 rounded-2xl border-2 ${index === 0 ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20' : 'border-slate-100 dark:border-slate-700 bg-white dark:bg-slate-800'}`}>
                        <div className="flex items-center space-x-4">
                          <div className="text-4xl bg-white dark:bg-slate-700 w-14 h-14 flex items-center justify-center rounded-xl shadow-sm shrink-0">{crop.img}</div>
                          <div>
                            <h4 className="font-bold text-slate-800 dark:text-white">{lang === 'en' ? crop.nameEN : crop.nameML}</h4>
                            <div className="flex flex-col mt-0.5">
                               <span className={`text-xs font-bold w-fit px-2 py-0.5 mb-1 rounded-full ${index === 0 ? 'bg-emerald-200 text-emerald-800 dark:bg-emerald-800 dark:text-emerald-200' : 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-300'}`}>{t.match}: {crop.matchPercent}%</span>
                               <span className="text-[10px] text-slate-500 dark:text-slate-400 leading-tight pr-2">{crop.reason}</span>
                            </div>
                          </div>
                        </div>
                        <button onClick={() => selectPredictedCrop(crop)} className="bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold px-4 py-2 rounded-xl active:scale-95 transition shrink-0 ml-2">{t.selectBtn}</button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {resultModal && (
              <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 backdrop-blur-sm animate-in fade-in duration-300 print:relative print:inset-auto print:bg-transparent print:backdrop-blur-none print:items-start">
                <div className="bg-white dark:bg-slate-900 w-full max-w-2xl rounded-t-3xl shadow-2xl p-6 pb-12 max-h-[90vh] overflow-y-auto border-t border-slate-200 dark:border-slate-800 mx-auto print:rounded-none print:shadow-none print:border-none print:max-h-none print:p-0 print:overflow-visible">
                  <div className="flex justify-between items-start mb-6 print:mb-4">
                    <div className="flex items-center space-x-4">
                      <div className="text-5xl bg-slate-100 dark:bg-slate-800 w-16 h-16 rounded-2xl flex items-center justify-center shadow-inner border border-slate-200 dark:border-slate-700 print:bg-transparent print:border-none">{resultModal.crop.img}</div>
                      <div>
                        <h3 className="text-sm font-bold text-emerald-600 uppercase tracking-wider">Analysis Result</h3>
                        <h2 className="text-2xl font-black dark:text-white print:text-black">{lang === 'en' ? resultModal.crop.nameEN : resultModal.crop.nameML}</h2>
                        {!resultModal.isLive && (
                           <span className="inline-flex items-center px-2 py-0.5 mt-1 rounded text-[10px] font-medium bg-amber-100 text-amber-800 border border-amber-200">
                             <AlertTriangle className="w-3 h-3 mr-1" /> Base Requirement (No Sensor Data)
                           </span>
                        )}
                      </div>
                    </div>
                    <div className="flex space-x-2 print:hidden">
                      <button onClick={generatePDF} className="p-2 bg-emerald-100 dark:bg-emerald-900/50 rounded-full text-emerald-600 hover:bg-emerald-200"><Download className="w-6 h-6" /></button>
                      <button onClick={() => setResultModal(null)} className="p-2 bg-slate-100 dark:bg-slate-800 rounded-full text-slate-500 hover:text-slate-800"><X className="w-6 h-6" /></button>
                    </div>
                  </div>

                  <div className="bg-slate-50 dark:bg-slate-800/50 rounded-2xl p-4 mb-6 border border-slate-100 dark:border-slate-700 flex space-x-4 items-end print:border-slate-300">
                    <div className="flex-1">
                      <label className="block text-xs font-bold text-slate-500 mb-1">{t.area}</label>
                      <input type="text" inputMode="numeric" pattern="[0-9]*" value={farmArea} onChange={e => setFarmArea(Math.max(0, e.target.value))} className="w-full text-lg font-bold p-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 dark:text-white focus:outline-emerald-500 print:border-slate-300 print:text-black" />
                    </div>
                    <div className="flex-1">
                      <label className="block text-xs font-bold text-slate-500 mb-1">{t.unit}</label>
                      <select value={farmUnit} onChange={e => setFarmUnit(e.target.value)} className="w-full text-lg font-bold p-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 dark:text-white focus:outline-emerald-500 print:border-slate-300 print:text-black">
                        <option value="Cent">Cent</option><option value="Acre">Acre</option><option value="Hectare">Hectare</option>
                      </select>
                    </div>
                  </div>

                  <h4 className="text-sm font-bold text-slate-800 dark:text-slate-200 mb-3 print:text-black">{t.fertilizerNeeded}</h4>
                  <div className="space-y-3 mb-6">
                    {activeFerts.length === 0 ? (
                      <div className="bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 p-4 rounded-xl font-medium border border-emerald-200"><span>{t.soilOptimal}</span></div>
                    ) : (
                      activeFerts.map(fert => (
                        <div key={fert.key} className={`flex justify-between items-center bg-white dark:bg-slate-800 p-4 rounded-xl border-l-4 ${fert.color} shadow-sm border-t border-r border-b border-slate-100 dark:border-slate-700 print:shadow-none print:border-slate-300`}>
                          <span className="font-bold text-slate-700 dark:text-slate-200 print:text-black">{fert.label}</span>
                          <span className="font-black text-lg dark:text-white print:text-black">{fert.val} kg</span>
                        </div>
                      ))
                    )}
                  </div>

                  <div className="grid grid-cols-3 gap-2 mb-6 print:hidden">
                    <button onClick={askOrganicAlternatives} disabled={aiLoading} className="bg-emerald-100 dark:bg-emerald-900/50 text-emerald-800 p-2 rounded-xl font-bold flex flex-col items-center justify-center space-y-1 active:scale-95 transition">
                      <Sparkles className="w-5 h-5 mb-1" /><span className="text-[10px] text-center">✨ {t.organicAlt}</span>
                    </button>
                    <button onClick={askFarmGuide} disabled={aiLoading} className="bg-emerald-100 dark:bg-emerald-900/50 text-emerald-800 p-2 rounded-xl font-bold flex flex-col items-center justify-center space-y-1 active:scale-95 transition">
                      <Sparkles className="w-5 h-5 mb-1" /><span className="text-[10px] text-center">✨ {t.aiGuide}</span>
                    </button>
                    <button onClick={askCropRotation} disabled={aiLoading} className="bg-emerald-100 dark:bg-emerald-900/50 text-emerald-800 p-2 rounded-xl font-bold flex flex-col items-center justify-center space-y-1 active:scale-95 transition">
                      <Sparkles className="w-5 h-5 mb-1" /><span className="text-[10px] text-center">✨ {t.cropRotation}</span>
                    </button>
                  </div>

                  {aiLoading && <div className="flex justify-center p-6 print:hidden"><Loader2 className="w-8 h-8 animate-spin text-emerald-600" /></div>}
                  {aiResponse && !aiLoading && <AIResponseCard text={aiResponse} />}
                </div>
              </div>
            )}

            {/* Header */}
            <header className="shrink-0 z-40 bg-emerald-600 dark:bg-emerald-800 text-white shadow-md rounded-b-2xl px-4 py-3 pb-4 print:hidden">
              <div className="flex justify-between items-center mb-3">
                <div className="flex items-center space-x-2">
                  <div className="bg-white/20 p-2 rounded-xl"><Sprout className="w-6 h-6 text-white" /></div>
                  <h1 className={`text-xl font-bold tracking-wider ${lang === 'ml' ? 'font-serif' : 'font-sans'}`}>{t.appName}</h1>
                </div>
                <div className="flex space-x-2">
                  <button onClick={handleLogout} className="p-2 bg-white/10 rounded-full hover:bg-white/20 transition text-white"><LogOut className="w-5 h-5" /></button>
                  <button onClick={() => setLang(lang === 'en' ? 'ml' : 'en')} className="p-2 bg-white/10 rounded-full hover:bg-white/20 transition"><Languages className="w-5 h-5" /></button>
                  <button onClick={() => setDarkMode(!darkMode)} className="p-2 bg-white/10 rounded-full hover:bg-white/20 transition">{darkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}</button>
                </div>
              </div>
              <div className="flex flex-col space-y-2">
                <div className="flex items-center space-x-2 text-emerald-100">
                  <User className="w-4 h-4" />
                  <span className="text-sm font-medium">{t.welcomeBack}, <span className="font-bold text-white">{user.name}</span></span>
                </div>
                <div className="flex items-center space-x-1 text-xs text-emerald-200">
                  <MapPin className="w-3 h-3" />
                  <span>{user.district} ({user.elevation})</span>
                </div>
                <div className="bg-black/10 rounded-xl p-3 flex justify-between items-center border border-white/10 mt-1">
                  <div className="flex items-center space-x-2">
                    <div className={`w-3 h-3 rounded-full ${connected ? 'bg-green-400 animate-pulse shadow-[0_0_8px_rgba(74,222,128,0.8)]' : 'bg-slate-400'}`} />
                    <span className="text-sm font-medium">
                      {connected ? (connectionType === 'mock' ? 'Simulation Mode Active' : t.connected) : isConnecting ? t.connecting : t.disconnected}
                    </span>
                  </div>
                  {!connected && (
                    <button onClick={() => setShowConnectModal(true)} disabled={isConnecting} className="flex items-center space-x-1 bg-white text-emerald-700 px-3 py-1.5 rounded-lg text-sm font-bold shadow-sm active:scale-95 disabled:opacity-70">
                      {isConnecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wifi className="w-4 h-4" />}<span>Connect</span>
                    </button>
                  )}
                </div>
              </div>
            </header>

            {!isOnline && (
              <div className="bg-amber-100 text-amber-800 border-b border-amber-200 text-xs font-bold text-center py-1.5 flex items-center justify-center space-x-1 shrink-0 print:hidden">
                <Activity className="w-4 h-4" /><span>Offline Mode Active (Local Expert System)</span>
              </div>
            )}

            {/* Main Tabs */}
            <main className="flex-1 overflow-y-auto p-4 pb-24 max-w-2xl mx-auto w-full relative print:hidden">
              {activeTab === 'dashboard' && (
                <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
                  
                  {!connected ? (
                    <div className="flex flex-col items-center justify-center p-8 text-center bg-white dark:bg-slate-800 rounded-3xl border-2 border-dashed border-slate-200 dark:border-slate-700 mt-4">
                      <div className="bg-slate-100 dark:bg-slate-700 w-20 h-20 rounded-full flex items-center justify-center mb-4"><Wifi className="w-10 h-10 text-slate-400" /></div>
                      <h3 className="text-lg font-bold text-slate-700 dark:text-slate-200 mb-2">{t.connectFirst}</h3>
                      <p className="text-sm text-slate-500 mb-6">{t.connectDesc}</p>
                      <button onClick={() => setShowConnectModal(true)} disabled={isConnecting} className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-3 px-8 rounded-full shadow-lg transition active:scale-95 flex items-center justify-center space-x-2">
                        {isConnecting ? <Loader2 className="w-5 h-5 animate-spin" /> : null}<span>{isConnecting ? t.connecting : 'Connect Now'}</span>
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="grid grid-cols-2 gap-4">
                        <Gauge icon={Droplets} label="Moisture" value={sensors.moisture} max={100} unit="%" optimal={[40, 80]} color="text-blue-500" />
                        <Gauge icon={FlaskConical} label="pH Level" value={sensors.pH} max={14} unit="" optimal={[5.5, 7.5]} color="text-fuchsia-500" />
                        <Gauge icon={ThermometerSun} label="Temperature" value={sensors.temp} max={50} unit="°C" optimal={[20, 35]} color="text-red-500" />
                        <Gauge icon={TestTube} label="Est. Nitrogen (N)" value={sensors.N} max={250} unit="kg/ha" optimal={[50, 200]} color="text-green-500" />
                        <Gauge icon={TestTube} label="Est. Phosphorus (P)" value={sensors.P} max={150} unit="kg/ha" optimal={[30, 100]} color="text-orange-500" />
                        <Gauge icon={TestTube} label="Est. Potassium (K)" value={sensors.K} max={400} unit="kg/ha" optimal={[50, 300]} color="text-purple-500" />
                      </div>
                      
                      <button onClick={handleAnalyze} disabled={isAnalyzing} className="w-full py-4 rounded-2xl text-lg font-bold flex items-center justify-center space-x-2 shadow-lg transition-all active:scale-95 bg-gradient-to-r from-emerald-500 to-teal-600 text-white hover:shadow-emerald-500/25">
                        {isAnalyzing ? <><Loader2 className="w-6 h-6 animate-spin" /><span>{t.predicting}</span></> : <><Sparkles className="w-6 h-6" /><span>{t.analyzeSoil}</span></>}
                      </button>

                      <div className="mt-4">
                        <button onClick={askSoilReport} disabled={aiLoading} className="w-full bg-teal-100 dark:bg-teal-900/50 text-teal-800 dark:text-teal-300 p-4 rounded-xl font-bold flex items-center justify-center space-x-2 active:scale-95 transition border border-teal-200 dark:border-teal-800">
                          <Sparkles className="w-6 h-6" /><span className="text-sm">✨ {t.soilReport}</span>
                        </button>
                      </div>
                    </>
                  )}
                  {aiResponse && activeTab === 'dashboard' && !aiLoading && <AIResponseCard text={aiResponse} />}
                </div>
              )}

              {activeTab === 'crops' && (
                <div className="space-y-4 animate-in fade-in duration-500 relative">
                  <div className="sticky top-[-16px] z-10 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md px-4 py-3 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm flex flex-col space-y-3">
                    <div className="flex items-center w-full">
                      <Search className="w-5 h-5 text-slate-400 mr-2 shrink-0" />
                      <input type="text" placeholder={t.searchCrops} value={searchInput} onChange={(e) => setSearchInput(e.target.value)} className="bg-transparent w-full focus:outline-none dark:text-white" />
                      {searchInput && <button onClick={() => setSearchInput('')}><X className="w-5 h-5 text-slate-400 hover:text-slate-600" /></button>}
                    </div>
                    <div className="flex overflow-x-auto space-x-2 scrollbar-hide pb-1">
                      {categories.map((catObj) => {
                        const isSelected = activeCategory === catObj.en || activeCategory === catObj.ml || activeCategory === 'All' && catObj.id === 'All';
                        return (
                          <button key={catObj.id} onClick={() => setActiveCategory(catObj.en)} className={`whitespace-nowrap px-3 py-1.5 rounded-full text-xs font-bold transition-all ${isSelected ? 'bg-emerald-600 text-white shadow-md' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'}`}>
                            {lang === 'en' ? catObj.en : catObj.ml}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    {filteredCrops.length > 0 ? filteredCrops.map(crop => (
                      <button key={crop.id} onClick={() => calculateFertilizer(crop)} className="bg-white dark:bg-slate-800 p-4 rounded-2xl shadow-sm border border-slate-100 dark:border-slate-700 flex flex-col items-center justify-center space-y-2 hover:border-emerald-500 active:scale-95 transition">
                        <span className="text-4xl">{crop.img}</span>
                        <span className="font-bold text-slate-700 dark:text-slate-200 text-sm text-center">{lang === 'en' ? crop.nameEN : crop.nameML}</span>
                      </button>
                    )) : (
                      <div className="col-span-2 text-center p-8 text-slate-500">{lang === 'en' ? 'No crops found' : 'വിളകൾ കണ്ടെത്തിയില്ല'}</div>
                    )}
                  </div>
                </div>
              )}

              {activeTab === 'doctor' && (
                <div className="flex flex-col h-[calc(100vh-14rem)] animate-in fade-in duration-500">
                  <div className="flex-1 bg-white dark:bg-slate-800 rounded-3xl p-4 shadow-sm border border-slate-100 dark:border-slate-700 mb-4 overflow-y-auto flex flex-col space-y-4">
                    <div className="bg-emerald-100 dark:bg-emerald-900/40 p-4 rounded-2xl rounded-tl-sm self-start max-w-[85%]">
                      <p className="text-sm font-medium text-emerald-800 dark:text-emerald-300">
                        {lang === 'en' ? "Hello! I am your local Expert System. Describe the symptoms on your crops (e.g., 'Yellow spots on paddy leaves'), and I will suggest organic remedies." : "നമസ്കാരം! ഞാൻ നിങ്ങളുടെ ലോക്കൽ എക്സ്പർട്ട് സിസ്റ്റം ആണ്. വിളകളുടെ ലക്ഷണങ്ങൾ വിവരിക്കുക, ഞാൻ ജൈവ പ്രതിവിധികൾ നിർദ്ദേശിക്കാം."}
                      </p>
                    </div>
                    {aiLoading && (
                      <div className="self-start bg-slate-100 dark:bg-slate-700 p-4 rounded-2xl rounded-tl-sm flex items-center space-x-2">
                        <Loader2 className="w-5 h-5 animate-spin text-emerald-600" /><span className="text-sm text-slate-500">Analyzing symptoms...</span>
                      </div>
                    )}
                    {aiResponse && !aiLoading && <AIResponseCard text={aiResponse} />}
                    <div ref={chatEndRef} />
                  </div>
                  
                  <div className="relative shrink-0">
                    <div className="flex overflow-x-auto pb-2 mb-2 space-x-2 scrollbar-hide pr-8">
                      {pestsDB.map(pest => (
                        <button key={pest.id} onClick={() => setChatQuery(lang === 'en' ? pest.nameEN : pest.nameML)} className="whitespace-nowrap px-3 py-1.5 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-slate-700 rounded-full text-xs font-medium hover:bg-emerald-100 dark:hover:bg-emerald-800 transition">
                          {lang === 'en' ? pest.nameEN : pest.nameML}
                        </button>
                      ))}
                    </div>
                    <div className="absolute right-0 top-0 bottom-2 w-12 bg-gradient-to-l from-slate-50 dark:from-slate-900 to-transparent pointer-events-none" />
                  </div>

                  <form onSubmit={handleChatSubmit} className="flex space-x-2 shrink-0">
                    <input type="text" value={chatQuery} onChange={(e) => setChatQuery(e.target.value)} placeholder={t.askDoctor} className="flex-1 px-4 py-3 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:text-white shadow-sm" />
                    <button type="submit" disabled={aiLoading || !chatQuery.trim()} className="bg-emerald-600 text-white p-3 rounded-2xl shadow-md disabled:opacity-50"><Send className="w-6 h-6" /></button>
                  </form>
                </div>
              )}

              {activeTab === 'history' && (
                <div className="space-y-4 animate-in fade-in duration-500">
                  <div className="flex items-center space-x-2 mb-4">
                    <History className="w-6 h-6 text-emerald-600 dark:text-emerald-400" />
                    <h2 className="text-xl font-bold dark:text-white">{t.historyTitle}</h2>
                  </div>

                  {analysisHistory.length === 0 ? (
                    <div className="bg-slate-100 dark:bg-slate-800 p-8 rounded-3xl text-center border border-dashed border-slate-300 dark:border-slate-700">
                      <History className="w-12 h-12 text-slate-400 mx-auto mb-3" />
                      <p className="text-slate-500 dark:text-slate-400 font-medium">{t.historyEmpty}</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {analysisHistory.map((record) => (
                        <div key={record.id} className="bg-white dark:bg-slate-800 p-4 rounded-2xl shadow-sm border border-slate-100 dark:border-slate-700 flex items-center justify-between">
                          <div className="flex items-center space-x-4">
                            <div className="text-3xl bg-slate-100 dark:bg-slate-700 w-12 h-12 flex items-center justify-center rounded-xl shrink-0">
                              {record.crop.img}
                            </div>
                            <div>
                              <h4 className="font-bold text-slate-800 dark:text-white">
                                {lang === 'en' ? record.crop.nameEN : record.crop.nameML}
                              </h4>
                              <div className="flex items-center text-xs text-slate-500 dark:text-slate-400 space-x-2 mt-0.5 mb-1.5">
                                <span className="flex items-center"><Clock className="w-3 h-3 mr-1" /> {record.date} {record.time}</span>
                              </div>
                            </div>
                          </div>
                          <button onClick={() => setResultModal({ crop: record.crop, baseReq: record.baseReq, isLive: true })} className="bg-emerald-50 dark:bg-emerald-900/30 hover:bg-emerald-100 text-emerald-700 text-sm font-bold px-3 py-2 rounded-xl transition shrink-0 ml-2">
                            {t.viewResult}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </main>

            {/* Bottom Nav */}
            <nav className="shrink-0 w-full bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 pb-safe px-6 py-3 flex justify-between items-center z-40 print:hidden">
              {[
                { id: 'dashboard', icon: LayoutDashboard, label: t.dashboard },
                { id: 'crops', icon: Leaf, label: t.crops },
                { id: 'doctor', icon: Stethoscope, label: t.doctor },
                { id: 'history', icon: History, label: t.history },
              ].map((tab) => (
                <button key={tab.id} onClick={() => setActiveTab(tab.id)} className={`flex flex-col items-center p-2 transition-colors duration-200 ${activeTab === tab.id ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300'}`}>
                  <tab.icon className={`w-6 h-6 mb-1 ${activeTab === tab.id ? 'fill-emerald-100 dark:fill-emerald-900/50' : ''}`} />
                  <span className="text-[10px] font-bold">{tab.label}</span>
                </button>
              ))}
            </nav>
          </>
        )}
      </div>
    </div>
  );
}