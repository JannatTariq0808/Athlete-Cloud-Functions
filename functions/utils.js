const admin = require("firebase-admin");
const axios = require("axios");
const {FieldValue} = require("firebase-admin/firestore");
const fetch = require("node-fetch");
const crypto = require("crypto");
const FitParser = require("fit-file-parser").default;

// const getCurrentQuarterTest = (monthOverride = null) => {
//   const allQuarters = [
//     {label: "Q1", month: 3, type: "Biology", startMonth: 1},
//     {label: "Q2", month: 6, type: "Nutrition", startMonth: 4},
//     {label: "Q3", month: 9, type: "Exercise", startMonth: 7},
//     {label: "Q4", month: 12, type: "Mental Health", startMonth: 10},
//   ];

//   const currentMonth =
//     monthOverride ?? (new Date().getUTCMonth() + 1);

//   return (
//     allQuarters.find(
//         (q) => currentMonth >= q.startMonth && currentMonth <= q.month,
//     ) || null
//   );
// };

const isQuarterFirstMonthDeadline = () => {
  const allQuarters = [
    {label: "Q1", month: 3, type: "Biology", startMonth: 1},
    {label: "Q2", month: 6, type: "Nutrition", startMonth: 4},
    {label: "Q3", month: 9, type: "Exercise", startMonth: 7},
    {label: "Q4", month: 12, type: "Mental Health", startMonth: 10},
  ];

  const now = new Date();
  const currentMonth = now.getUTCMonth() + 1;
  const currentDate = now.getUTCDate();

  // Find current quarter
  let currentQuarter = null;
  for (const quarter of allQuarters) {
    const endMonth = quarter.month;
    const startMonth = endMonth - 2;
    if (currentMonth >= startMonth && currentMonth <= endMonth) {
      currentQuarter = quarter;
      break;
    }
  }

  if (!currentQuarter) return false;

  // Last day of first month
  const firstMonth = currentQuarter.startMonth;

  const lastDay = new Date(
      Date.UTC(now.getUTCFullYear(), firstMonth, 0),
  ).getUTCDate();
  console.log(
      `${currentMonth} firstMomth ${firstMonth} lastday ${lastDay} currentDate ${currentDate} ${
        currentMonth === firstMonth && currentDate === lastDay
      }`,
  );
  return currentMonth === firstMonth && currentDate === lastDay;
};

const getCurrentQuarter = () => {
  const allQuarters = [
    {label: "Q1", month: 3, type: "Biology", startMonth: 1},
    {label: "Q2", month: 6, type: "Nutrition", startMonth: 4},
    {label: "Q3", month: 9, type: "Exercise", startMonth: 7},
    {label: "Q4", month: 12, type: "Mental Health", startMonth: 10},
  ];

  const now = new Date();
  const currentMonth = now.getUTCMonth() + 1;

  let currentQuarter = null;
  for (const quarter of allQuarters) {
    const endMonth = quarter.month;
    const startMonth = endMonth - 2;
    if (currentMonth >= startMonth && currentMonth <= endMonth) {
      currentQuarter = quarter;
      break;
    }
  }
  return currentQuarter;
};

const getPreviousQuarter = (currentQuarter, currentYear) => {
  // All quarters in order
  const allQuarters = [
    {label: "Q1", month: 3, type: "Biology"},
    {label: "Q2", month: 6, type: "Nutrition"},
    {label: "Q3", month: 9, type: "Exercise"},
    {label: "Q4", month: 12, type: "Mental Health"},
  ];

  if (!currentQuarter || !currentQuarter.label) {
    console.warn("Invalid currentQuarter passed:", currentQuarter);
    // fallback: return Q4 of previous year
    return {prevQuarter: allQuarters[3], prevYear: currentYear - 1};
  }

  // Find the index of current quarter
  const idx = allQuarters.findIndex((q) => q.label === currentQuarter.label);

  if (idx === -1) {
    console.warn("Current quarter label not found:", currentQuarter.label);
    // fallback: Q4 of previous year
    return {prevQuarter: allQuarters[3], prevYear: currentYear - 1};
  }

  // If current quarter is Q1, previous is Q4 of last year
  if (idx === 0) {
    return {prevQuarter: allQuarters[3], prevYear: currentYear - 1};
  }

  // Normal case: previous quarter in same year
  return {prevQuarter: allQuarters[idx - 1], prevYear: currentYear};
};

const getNextAssessmentInfo = () => {
  const allQuarters = [
    {label: "Q1", month: 3, type: "Biology"},
    {label: "Q2", month: 6, type: "Nutrition"},
    {label: "Q3", month: 9, type: "Exercise"},
    {label: "Q4", month: 12, type: "Mental Health"},
  ];

  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const assessmentStartMonths = [1, 4, 7, 10];

  let nextAssessmentMonth;
  let nextYear = year;

  for (const m of assessmentStartMonths) {
    if (m > month) {
      nextAssessmentMonth = m;
      break;
    }
  }

  nextAssessmentMonth = nextAssessmentMonth || assessmentStartMonths[0];
  if (nextAssessmentMonth <= month) {
    nextYear += 1;
  }

  const nextAssessment = new Date(
      Date.UTC(nextYear, nextAssessmentMonth - 1, 1, 0, 0, 0),
  );

  console.log(nextYear, nextAssessmentMonth);

  let topic;
  switch (nextAssessmentMonth) {
    case 1:
      topic = allQuarters.find((q) => q.label === "Q1").type;
      break;
    case 4:
      topic = allQuarters.find((q) => q.label === "Q2").type;
      break;
    case 7:
      topic = allQuarters.find((q) => q.label === "Q3").type;
      break;
    case 10:
      topic = allQuarters.find((q) => q.label === "Q4").type;
      break;
  }

  return {nextAssessment, topic};
};

const shouldSendNotification = (targetDate, daysBefore) => {
  console.log(targetDate, "--", daysBefore);
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const today = new Date(Date.UTC(year, month - 1, now.getUTCDate()));

  const notificationDate = new Date(targetDate);
  notificationDate.setUTCDate(targetDate.getUTCDate() - daysBefore);

  const targetNotificationDate = new Date(
      Date.UTC(
          notificationDate.getUTCFullYear(),
          notificationDate.getUTCMonth(),
          notificationDate.getUTCDate(),
      ),
  );

  return today.getTime() === targetNotificationDate.getTime();
};

const sendEmail = async (
    brevoApiKey,
    emailSubject,
    emailBody,
    topic,
    targetUsers = null, // optional: array of { email, name }
) => {
  const db = admin.firestore();
  let users = [];

  if (targetUsers && targetUsers.length > 0) {
    // ✅ Use provided users
    users = targetUsers;
  } else {
    // ✅ Fallback: fetch from Firestore
    const usersSnapshot = await db
        .collection("users")
        .where("assessment_updates", "==", true)
        .get();

    users = usersSnapshot.docs.map((doc) => ({
      email: doc.data().email,
      name: doc.data().display_name || "Athlete",
    }));
  }

  for (const user of users) {
    try {
      await axios.post(
          "https://api.brevo.com/v3/smtp/email",
          {
            sender: {
              name: "The Athlete Team",
              email: "alex@app.lifeathlete.co",
            },
            to: [{email: user.email, name: user.name}],
            subject: emailSubject.replace(
                "{locked_amount}",
                user.locked_amount || "0",
            ),
            htmlContent: emailBody
                .replace("{user.name}", user.name)
                .replace("${topic}", topic)
                .replace("{locked_amount}", user.locked_amount || "0"),
          },
          {
            headers: {
              "accept": "application/json",
              "api-key": brevoApiKey,
              "content-type": "application/json",
            },
          },
      );
    } catch (error) {
      console.error(
          `❌ Failed to send email to ${user.email}:`,
          error.response?.data || error.message,
      );
    }
    await delay(50); // Respect Brevo rate limits
  }
};

/**
 * Send push notifications.
 *
 * Modes:
 * 1. perUserMessages: array of {userId, title, body, data} → personalized per-user pushes
 * 2. targetedUsers: array of userIds with same pushTitle, pushBody, additionalData → multicast
 * 3. topic: default broadcast if neither above provided
 */
const sendPush = async ({
  pushTitle = "",
  pushBody = "",
  topic = "assessment_updates",
  additionalData = {},
  targetedUsers = null,
  perUserMessages = null,
}) => {
  const db = admin.firestore();

  // Case 1: Per-user custom messages
  if (perUserMessages?.length) {
    const messages = [];

    for (const {userId, title, body, data = {}} of perUserMessages) {
      const tokensSnapshot = await db
          .collection("users")
          .doc(userId)
          .collection("fcm_tokens")
          .get();

      tokensSnapshot.forEach((doc) => {
        const tokenData = doc.data();
        if (tokenData.fcm_token) {
          messages.push({
            notification: {title, body},
            token: tokenData.fcm_token,
            data: {initialPageName: "Home", ...data},
          });
        }
      });
    }

    if (!messages.length) {
      console.log("No valid FCM tokens for per-user messages.");
      return;
    }

    try {
      const response = await admin.messaging().sendEach(messages);
      console.log(
          `Custom push: ${response.successCount} sent, ${response.failureCount} failed.`,
      );
    } catch (error) {
      console.error("Error sending per-user push:", error);
    }
    return;
  }

  // Case 2: Targeted users, same message for all (multicast)
  if (targetedUsers?.length) {
    const tokenSet = new Set();

    for (const userId of targetedUsers) {
      const tokensSnapshot = await db
          .collection("users")
          .doc(userId)
          .collection("fcm_tokens")
          .get();

      tokensSnapshot.forEach((doc) => {
        const tokenData = doc.data();
        if (tokenData.fcm_token) tokenSet.add(tokenData.fcm_token);
      });
    }

    const validTokens = Array.from(tokenSet);
    if (!validTokens.length) {
      console.log("No valid tokens for multicast push.");
      return;
    }

    const chunkSize = 500;
    for (let i = 0; i < validTokens.length; i += chunkSize) {
      const chunk = validTokens.slice(i, i + chunkSize);
      const message = {
        notification: {title: pushTitle, body: pushBody},
        tokens: chunk,
        data: {initialPageName: "Home", ...additionalData},
      };

      try {
        await admin.messaging().sendEachForMulticast(message);
        console.log(`Multicast push sent to ${chunk.length} tokens.`);
      } catch (error) {
        console.error("Error sending multicast push:", error);
      }
    }
    return;
  }

  // Case 3: Topic broadcast (default)
  try {
    await admin.messaging().send({
      notification: {title: pushTitle, body: pushBody},
      topic,
      data: {initialPageName: "Home", ...additionalData},
    });
    console.log(`Topic push sent to "${topic}".`);
  } catch (error) {
    console.error("Error sending topic push:", error);
  }
};

const createAppNotifications = async (title, message, type, targetedUsers) => {
  const db = admin.firestore();
  const batch = db.batch();

  if (message) {
    // Case 1: same message for all (global update)
    if (type === "assessment_updates") {
      const allUserIds = [];
      if (!targetedUsers || targetedUsers.length === 0) {
        const snapshot = await db
            .collection("users")
            .where("assessment_updates", "==", true)
            .get();
        snapshot.forEach((doc) => allUserIds.push(doc.id));
      } else {
        allUserIds.push(...targetedUsers);
      }

      if (allUserIds.length > 0) {
        const notificationRef = db.collection("notifications").doc();
        batch.set(notificationRef, {
          title,
          message,
          type,
          targetedUsers: allUserIds, // single notification for all users
          seen_by: [],
          created_at: FieldValue.serverTimestamp(),
        });
      }
    } else if (type === "article_updates") {
      const allUserIds = [];
      if (!targetedUsers || targetedUsers.length === 0) {
        const snapshot = await db
            .collection("users")
            .where("article_updates", "==", true)
            .get();
        snapshot.forEach((doc) => allUserIds.push(doc.id));
      } else {
        allUserIds.push(...targetedUsers);
      }

      if (allUserIds.length > 0) {
        const notificationRef = db.collection("notifications").doc();
        batch.set(notificationRef, {
          title,
          message,
          type,
          targetedUsers: allUserIds, // single notification for all users
          seen_by: [],
          created_at: FieldValue.serverTimestamp(),
        });
      }
    }
  } else {
    // Case 2: custom message per user
    if (!Array.isArray(targetedUsers) || targetedUsers.length === 0) {
      throw new Error("targetedUsers must be provided when message is empty");
    }

    targetedUsers.forEach(({userId, message: userMessage}) => {
      if (!userId || !userMessage) {
        throw new Error("Each targeted user must have userId and message");
      }

      const notificationRef = db.collection("notifications").doc();
      batch.set(notificationRef, {
        title,
        message: userMessage,
        type,
        targetedUsers: [userId], // per-user message
        seen_by: [],
        created_at: FieldValue.serverTimestamp(),
      });
    });
  }

  await batch.commit();
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const email_footer = `
<footer style="color:black;margin-top:30px;font-family:Arial, sans-serif;font-size:10px;max-width:100%;text-align:left;">
  <h3 style="margin:0 0 4px 0;font-weight:bold;">Athlete Life Insurance</h3>
  <p style="margin:2px 0;color:blue;">hello@lifeathlete.co</p>
  <p style="margin:2px 0;"><a href="http://lifeathlete.co" style="color:black;text-decoration:underline;">lifeathlete.co</a></p>

  <img src="https://firebasestorage.googleapis.com/v0/b/athlete-46037.firebasestorage.app/o/email_footer_banner.jpg?alt=media&token=6b01eb93-0693-482d-90de-bc3ae826f163" alt="Athlete Life Insurance Banner" style="max-width:100%;height:auto;display:block;margin:10px 0;">

  <p style="margin:0;color:#888;line-height:1.3;">
    Athlete acts solely as an introducer to our partner advisors, Cover Direct. 
    Cover Direct is authorised by the Financial Conduct Authority (FCA, registration number 785970) 
    to provide insurance advice. Athlete Life Ltd is registered in England and Wales (company number 15884396) 
    with its registered office at 104 West End Avenue, Harrogate, UK
  </p>
</footer>
`;

// const TEST_EVENT_CODE = "TEST60971"; // optional for testing

// Hash email for Meta
const hashEmail = (email) =>
  crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
const hashPhone = (phone) => {
  if (!phone) return null;

  // Remove everything except digits
  let normalized = phone.replace(/\D/g, "");

  // Remove leading zeros
  normalized = normalized.replace(/^0+/, "");

  // Add country code if missing (example for UK: 44, US: 1)
  // Change the defaultCountryCode according to your data
  const defaultCountryCode = "44"; // UK
  if (!normalized.startsWith(defaultCountryCode)) {
    normalized = defaultCountryCode + normalized;
  }

  // Hash using SHA256
  return crypto.createHash("sha256").update(normalized).digest("hex");
};

const hashString = (str) => {
  if (!str) return null;
  return crypto
      .createHash("sha256")
      .update(str.trim().toLowerCase())
      .digest("hex");
};

// Build payload per event type
const buildEventPayload = (eventType, leadData) => {
  // Hash email
  const userData = {em: [hashEmail(leadData.email)]};
  if (leadData.phone) {
    const phHash = hashPhone(leadData.phone);
    if (phHash) userData.ph = [phHash];
  }
  if (leadData.fbclid) {
    const timestampMs = Date.now();
    userData.fbc = `fb.1.${timestampMs}.${leadData.fbclid}`;
  }
  if (leadData.client_user_agent) {
    userData.client_user_agent = leadData.client_user_agent;
  }
  if (leadData.client_ip_address) {
    userData.client_ip_address = leadData.client_ip_address;
  }
  if (leadData.first_name) userData.fn = [hashString(leadData.first_name)];
  if (leadData.city) userData.ct = [hashString(leadData.city)];
  if (leadData.country) userData.country = [hashString(leadData.country)];
  const basePayload = {
    event_name: eventType,
    event_time: Math.floor(Date.now() / 1000),
    action_source: "website",
    user_data: userData,
    event_id: crypto.randomUUID(),
  };

  switch (eventType) {
    case "Lead":
      basePayload.custom_data = {content_name: "Form Submission"};
      break;
    case "Schedule":
      basePayload.custom_data = {content_name: "Call Scheduled"};
      break;
    case "Contact":
      basePayload.custom_data = {content_name: "Call Attended"};
      break;
    case "Purchase":
      basePayload.custom_data = {
        content_name: "Policy Purchased",
        value: leadData.premiumValue || 0,
        currency: "GBP",
      };
      break;
    default:
      basePayload.custom_data = {};
  }

  return basePayload;
};

const sendMetaEvent = async (eventType, leadData, PIXEL_ID, ACCESS_TOKEN) => {
  const eventPayload = buildEventPayload(eventType, leadData);
  // const payload = {
  //   data: [eventPayload],
  //   test_event_code: TEST_EVENT_CODE,
  // };
  const payload = {
    data: [eventPayload],
  };

  const url = `https://graph.facebook.com/v24.0/${PIXEL_ID}/events?access_token=${ACCESS_TOKEN}`;
  const response = await fetch(url, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: {"Content-Type": "application/json"},
  });

  const data = await response.json();
  console.log("Meta response:", data);
  return data;
};

const formatDate = (timestamp) => {
  if (!timestamp || !timestamp.toDate) return null;
  const d = timestamp.toDate();

  // Use UTC instead of local time
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const year = d.getUTCFullYear();

  return `${month}-${day}-${year}`;
};

// function monthsUntilNextAssessment(currentQuarter) {
//   const now = new Date();
//   const currentMonth = now.getUTCMonth() + 1;
//   const endMonth = currentQuarter.month;

//   const remaining = (endMonth - currentMonth) + 1;
//   if (remaining < 0) return 0;
//   if (remaining === 0) return 1;
//   return remaining;
// }

// // ---- Utility: findRebateLevel ----
// function findRebateLevel(monthlyPrice, athleteLevel) {
//   const rebateMap = {
//     10: 0.50,
//     9: 0.30,
//     8: 0.25,
//     7: 0.20,
//     6: 0.15,
//     5: 0.10,
//     4: 0.05,
//     3: 0.03,
//     2: 0.02,
//     1: 0.0,
//   };
//   const rebatePercent = rebateMap[athleteLevel] ?? 0.0;
//   return monthlyPrice * rebatePercent;
// }

// // ---- Utility: calculatePending ----
// function calculatePending(monthlyRebate, currentQuarter) {
//   const monthsRemaining = monthsUntilNextAssessment(currentQuarter);
//   return monthlyRebate * monthsRemaining;
// }

const paginate = (
    items,
    {
      pageSize = 10,
      pageToken = null,
      pageNumber = null,
      direction = "next",
      tokenKeyExtractor = (item) => item.id_ref,
    } = {},
) => {
  const totalCount = items.length;
  const totalPages = Math.ceil(totalCount / pageSize);

  let startIdx = 0;
  let endIdx = pageSize;

  if (pageNumber) {
    startIdx = (pageNumber - 1) * pageSize;
    endIdx = Math.min(startIdx + pageSize, totalCount);
  } else if (pageToken) {
    const tokenIndex = items.findIndex(
        (item) => tokenKeyExtractor(item) === pageToken,
    );

    if (tokenIndex === -1) {
      startIdx = 0;
    } else if (direction === "next") {
      startIdx = tokenIndex + 1;
    } else if (direction === "prev") {
      // ✅ FIX: Move back one full page before the current token
      endIdx = tokenIndex;
      startIdx = Math.max(0, endIdx - pageSize);
    }

    if (direction === "next") {
      endIdx = Math.min(startIdx + pageSize, totalCount);
    }
  }

  const pagedResults = items.slice(startIdx, endIdx);

  const nextPageToken =
    endIdx < totalCount ?
      tokenKeyExtractor(pagedResults[pagedResults.length - 1]) :
      null;

  const prevPageToken =
    startIdx > 0 ? tokenKeyExtractor(pagedResults[0]) : null;

  return {
    data: pagedResults,
    nextPageToken,
    prevPageToken,
    totalCount,
    totalPages,
    currentPage: pageNumber || Math.ceil(endIdx / pageSize),
  };
};

const chunkArray = (array, size) => {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
};

const getExerciseFitnessInfo = (leads) => {
  const isPresent = (v) => v !== undefined && v !== null && v !== "";

  const cardio = isPresent(leads.cardio) ? String(leads.cardio) : null;

  let perf = null;
  if (isPresent(leads.running_5k)) {
    perf = String(leads.running_5k);
  } else if (isPresent(leads.ftp)) {
    perf = String(leads.ftp);
  } else if (isPresent(leads.vigorous)) {
    perf = String(leads.vigorous);
  }

  if (perf && cardio) return `${cardio}, ${perf}`;
  if (perf) return perf;
  if (cardio) return cardio;
  return null;
};

const generateRandomString = (length = 128) => {
  return crypto.randomBytes(length).toString("base64url");
};

const generateCodeChallenge = (codeVerifier) => {
  const hash = crypto.createHash("sha256").update(codeVerifier).digest();
  return Buffer.from(hash).toString("base64url");
};

const findCardioLevel = (predicted5kMin, gender, dob, distance5k) => {
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  if (
    now.getMonth() < dob.getMonth() ||
    (now.getMonth() === dob.getMonth() && now.getDate() < dob.getDate())
  ) {
    age--;
  }

  const female = {
    "18-29": [
      [40, 35],
      [34.9, 31.1],
      [31, 28],
      [27.9, 25.5],
      [25.4, 23.3],
      [23.2, 21.5],
      [21.4, 18.7],
      [18.6, 16.5],
      [16.4, 14.7],
      [14.6, 14],
    ],
    "30-39": [
      [40.8, 35.7],
      [35.6, 31.7],
      [31.6, 28.6],
      [28.5, 26],
      [25.9, 23.8],
      [23.7, 22],
      [21.8, 19],
      [19, 16.8],
      [16.7, 15],
      [14.9, 14.3],
    ],
  };

  const male = {
    "18-29": [
      [37.1, 32.5],
      [32.4, 28.9],
      [28.8, 26],
      [25.9, 23.6],
      [23.5, 21.7],
      [21.6, 20],
      [19.9, 17.3],
      [17.2, 15.3],
      [15.2, 13.7],
      [13.6, 13],
    ],
    "30-39": [
      [37.9, 33.2],
      [33.1, 29.5],
      [29.4, 26.5],
      [26.4, 24.1],
      [24, 22.1],
      [22, 20.4],
      [20.3, 17.7],
      [17.6, 15.6],
      [15.5, 14],
      [13.9, 13.3],
    ],
  };

  const table = gender?.toLowerCase() === "male" ? male : female;

  let bracket = "18-29";
  if (age >= 30) bracket = "30-39";

  const levels = table[bracket] || table["18-29"];
  const fastest =
    (predicted5kMin * 1440 * Math.pow(5 / distance5k, 1.07)) / 1440;

  if (fastest > levels[0][0]) return 1;
  if (fastest <= levels[levels.length - 1][1]) return 10;

  for (let i = 0; i < levels.length; i++) {
    const [max, min] = levels[i];
    if (fastest <= max && fastest > min) return i + 1;
  }

  return 10;
};

const saveToCardio = async (db, userRef, subcollectionName, data) => {
  console.log(`Saving entry to ${subcollectionName}…`);

  const cardioQuery = await db
      .collection("cardios")
      .where("user_ref", "==", userRef)
      .where("platform", "==", "garmin")
      .limit(1)
      .get();

  let cardioRef;
  if (!cardioQuery.empty) {
    cardioRef = cardioQuery.docs[0].ref;
    console.log(" → Using existing cardio doc:", cardioRef.path);
  } else {
    cardioRef = db.collection("cardios").doc();
    await cardioRef.set({
      user_ref: userRef,
      platform: "garmin",
      created_at: admin.firestore.FieldValue.serverTimestamp(),
      is_completed: true,
    });
    console.log(" → Created new cardio doc:", cardioRef.path);
  }

  await cardioRef.collection(subcollectionName).add({
    ...data,
    cardio_id: cardioRef,
    assessment_ref: null,
    user_ref: userRef,
  });

  console.log(` → Added entry to ${subcollectionName}`);
};

const parseFitFile = (fitBuffer) => {
  return new Promise((resolve, reject) => {
    const fitParser = new FitParser({force: true, mode: "list"});

    fitParser.parse(fitBuffer, (error, data) => {
      if (error) {
        console.error("❌ FIT PARSE ERROR:", error);
        return reject(error);
      }

      const records = data.records || [];
      const sessions = data.sessions || [];

      if (!records.length) {
        console.warn("⚠️ No records found in FIT");
        return resolve({});
      }

      // Separate counters for power and HR
      let powerSum = 0;
      let powerCount = 0;
      let hrSum = 0;
      let hrCount = 0;

      let maxPower = 0;
      let maxHr = 0;
      let totalElapsedTime = 0;
      let totalTimerTime = 0; // Timer time (excludes manual pauses)
      let movingTime = 0;
      let distance = 0;

      // Track first and last timestamps
      const firstTimestamp = records[0].timestamp;
      const lastTimestamp = records[records.length - 1].timestamp;

      // Get activity start time (for date tracking)
      let activityStartTime = null;
      if (firstTimestamp) {
        activityStartTime = new Date(firstTimestamp);
      }

      // Try to get timer time from session data (most accurate)
      if (sessions.length > 0) {
        const session = sessions[0];
        if (session.total_timer_time != null) {
          totalTimerTime = session.total_timer_time;
        }
      }

      // Debug counters
      let validPowerRecords = 0;
      let validHrRecords = 0;
      let zeroPowerRecords = 0;
      let stoppedRecords = 0;
      let speedRecordsFound = 0;
      let pausedTimeSeconds = 0;

      // Process each record individually (not delta-based)
      for (let i = 0; i < records.length; i++) {
        const curr = records[i];

        // Track power (including zeros - they're valid data points)
        if (curr.power != null && !isNaN(curr.power)) {
          powerSum += curr.power;
          powerCount++;
          maxPower = Math.max(maxPower, curr.power);
          validPowerRecords++;

          if (curr.power === 0) {
            zeroPowerRecords++;
          }
        }

        // Track heart rate
        if (
          curr.heart_rate != null &&
          !isNaN(curr.heart_rate) &&
          curr.heart_rate > 0
        ) {
          hrSum += curr.heart_rate;
          hrCount++;
          maxHr = Math.max(maxHr, curr.heart_rate);
          validHrRecords++;
        }

        // Track distance (use the last valid value)
        if (curr.distance != null && curr.distance > distance) {
          distance = curr.distance;
        }

        // Check speed availability
        if (curr.speed != null) {
          speedRecordsFound++;
        }

        // Count moving time - matching Garmin's auto-pause logic
        if (i > 0) {
          const prev = records[i - 1];

          if (prev.timestamp && curr.timestamp) {
            const deltaTime =
              (new Date(curr.timestamp) - new Date(prev.timestamp)) / 1000;

            // Detect manual pauses (gaps > 10 seconds suggest manual pause/stop)
            if (deltaTime > 10) {
              console.log(
                  `⏸️ Detected potential manual pause: ${deltaTime}s gap at record ${i}`,
              );
            }

            // Only count reasonable time deltas (1-10 seconds between records)
            if (deltaTime > 0 && deltaTime <= 10) {
              let isMoving = false;

              // Priority 1: Check distance change (most reliable for moving time)
              if (curr.distance != null && prev.distance != null) {
                const distanceChange = curr.distance - prev.distance;
                // Consider moving if traveled > 1 meter in this interval
                if (distanceChange > 1) {
                  isMoving = true;
                }
              }

              // Priority 2: Use speed if distance isn't available
              if (!isMoving && curr.speed != null) {
                // Speed > 0.5 m/s (~1.8 km/h) - typical Garmin auto-pause threshold
                if (curr.speed > 0.5) {
                  isMoving = true;
                }
              }

              // Priority 3: Use power as last resort
              if (!isMoving && curr.power != null && curr.power > 10) {
                // If generating significant power, must be moving
                isMoving = true;
              }

              if (isMoving) {
                movingTime += deltaTime;
              } else {
                stoppedRecords++;
                pausedTimeSeconds += deltaTime;
              }
            }
          }
        }
      }

      // Calculate total elapsed time from timestamps
      if (firstTimestamp && lastTimestamp) {
        totalElapsedTime =
          (new Date(lastTimestamp) - new Date(firstTimestamp)) / 1000;
      }

      // If we didn't find timer time in session, calculate it from records
      // Timer time = elapsed time - manual pause gaps
      if (totalTimerTime === 0) {
        totalTimerTime = 0;
        for (let i = 1; i < records.length; i++) {
          const prev = records[i - 1];
          const curr = records[i];

          if (prev.timestamp && curr.timestamp) {
            const deltaTime =
              (new Date(curr.timestamp) - new Date(prev.timestamp)) / 1000;

            // Only add time if gap is reasonable (< 10s = timer was running)
            if (deltaTime > 0 && deltaTime <= 10) {
              totalTimerTime += deltaTime;
            }
            // Gaps > 10s are considered manual pauses (timer stopped)
          }
        }
      }

      // Calculate averages using simple mean (not time-weighted)
      const avgPower = powerCount > 0 ? Math.round(powerSum / powerCount) : 0;
      const avgHr = hrCount > 0 ? Math.round(hrSum / hrCount) : 0;

      const formatTime = (seconds) => {
        const mins = Math.floor(seconds / 60);
        const secs = Math.round(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, "0")}`;
      };

      console.log("📈 FIT STATS DEBUG");
      console.log({
        activityDate: activityStartTime?.toISOString(),
        totalRecords: records.length,
        validPowerRecords,
        validHrRecords,
        zeroPowerRecords,
        stoppedRecords,
        speedRecordsFound,
        totalTime: formatTime(totalTimerTime) + " (timer running)",
        elapsedTime: formatTime(totalElapsedTime) + " (start to finish)",
        movingTime: formatTime(movingTime) + " (actually moving)",
        pausedTime: formatTime(pausedTimeSeconds) + " (auto-pause)",
        manualPauseTime:
          formatTime(totalElapsedTime - totalTimerTime) + " (manual pause)",
        totalTimeSeconds: Math.round(totalTimerTime),
        elapsedTimeSeconds: Math.round(totalElapsedTime),
        movingTimeSeconds: Math.round(movingTime),
        avgPower,
        maxPower,
        avgHr,
        maxHr,
        distanceMeters: Math.round(distance),
        distanceKm: (distance / 1000).toFixed(2),
        avgSpeed:
          distance > 0 && movingTime > 0 ?
            ((distance / movingTime) * 3.6).toFixed(1) + " km/h" :
            "N/A",
      });

      resolve({
        activityDate: activityStartTime,
        avgPower,
        maxPower,
        avgHr,
        maxHr,
        movingTime: Math.round(movingTime),
        totalTime: Math.round(totalTimerTime), // NEW: Timer time
        elapsedTime: Math.round(totalElapsedTime),
        duration: Math.round(totalTimerTime), // Duration = timer time (not elapsed)
        distance: Math.round(distance),
      });
    });
  });
};

const getValidAccessToken = async (sessionDoc, CLIENT_ID, CLIENT_SECRET) => {
  const data = sessionDoc.data();
  const {accessToken, refreshToken, token_expiry} = data;

  const now = new Date();

  // Check if the token is still valid
  if (token_expiry && now < token_expiry.toDate()) {
    // Token is still valid
    return accessToken;
  }

  // Token expired — refresh it
  console.log("Access token expired, refreshing...");

  const tokenRes = await axios.post(
      "https://diauth.garmin.com/di-oauth2-service/oauth/token",
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
      {
        auth: {
          username: CLIENT_ID,
          password: CLIENT_SECRET,
        },
        headers: {"Content-Type": "application/x-www-form-urlencoded"},
      },
  );

  const {access_token, refresh_token, expires_in} = tokenRes.data;

  // Update Firestore with new token & expiry
  const newExpiry = new Date(Date.now() + expires_in * 1000);

  await sessionDoc.ref.update({
    accessToken: access_token,
    refreshToken: refresh_token,
    token_expiry: newExpiry,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  console.log("Access token refreshed, new expiry:", newExpiry);

  return access_token;
};

const deleteAllGarminBatchesForUser = async ({userRef, garminUserId}) => {
  const db = admin.firestore();
  let batchQuery;

  if (userRef) {
    // Check if userRef is valid
    if (!userRef || !userRef.path) {
      console.warn("⚠️ Invalid userRef provided for batch cleanup");
      return;
    }
    batchQuery = db
        .collection("garminSyncBatches")
        .where("userId", "==", userRef);
  } else if (garminUserId) {
    batchQuery = db
        .collection("garminSyncBatches")
        .where("garminUserId", "==", garminUserId);
  } else {
    console.warn("⚠️ No userRef or garminUserId provided for batch cleanup");
    return;
  }
  const batchSnap = await batchQuery.get();

  if (batchSnap.empty) {
    console.log("ℹ️ No garminSyncBatches found to delete");
    return;
  }

  console.log(`🧹 Deleting ${batchSnap.size} garminSyncBatches`);

  for (const batchDoc of batchSnap.docs) {
    const batchRef = batchDoc.ref;

    // Delete activities subcollection
    const activitiesSnap = await batchRef.collection("activities").get();
    await Promise.all(activitiesSnap.docs.map((doc) => doc.ref.delete()));

    // Delete batch doc
    await batchRef.delete();

    console.log(`🗑️ Deleted batch ${batchRef.id}`);
  }
};

// ---------------------------
// Helper function for delayed registration check and backfill
// ---------------------------
const scheduleGarminRegistrationCheck = async ({
  userRefPath,
  batchId,
  access_token,
  appRedirectUri,
}) => {
  const userRef = admin.firestore().doc(userRefPath);

  // Retry loop to wait until Garmin registers the user
  let garminUserId = null;
  const maxRetries = 6; // retry up to 6 times
  const delayMs = 10000; // 10 seconds

  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await axios.get(
          "https://apis.garmin.com/wellness-api/rest/user/id",
          {
            headers: {Authorization: `Bearer ${access_token}`},
          },
      );
      garminUserId = res.data.userId;
      break;
    } catch (err) {
      console.warn(`Garmin userId not ready yet, retry ${i + 1}/${maxRetries}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  if (!garminUserId) {
    console.error("Garmin registration did not complete in time");
    return;
  }

  // Save Garmin userId
  await userRef.update({garminUserId});

  // Backfill activities
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const sevenDaysAgoSec = nowSec - 7 * 24 * 60 * 60;

    const backfillRes = await axios.get(
        "https://apis.garmin.com/wellness-api/rest/backfill/activities",
        {
          params: {
            userId: garminUserId,
            summaryStartTimeInSeconds: sevenDaysAgoSec,
            summaryEndTimeInSeconds: nowSec,
          },
          headers: {Authorization: `Bearer ${access_token}`},
        },
    );

    console.log("✅ Garmin backfill activities fetched:", backfillRes.status);
  } catch (err) {
    console.warn(
        "⚠️ Failed to fetch Garmin backfill activities:",
        err.response?.data || err,
    );
  }

  // Update batch if exists
  if (batchId) {
    await admin
        .firestore()
        .collection("garminSyncBatches")
        .doc(batchId)
        .update({garminUserId});
    console.log(`✅ Updated batch ${batchId} with Garmin userId`);
  }

  // Permissions check
  try {
    const permissionsRes = await axios.get(
        "https://apis.garmin.com/wellness-api/rest/user/permissions",
        {
          headers: {Authorization: `Bearer ${access_token}`},
        },
    );

    const grantedPermissions = permissionsRes.data.permissions || [];
    console.log("Final Garmin permissions:", grantedPermissions);

    if (grantedPermissions.includes("HISTORICAL_DATA_EXPORT")) {
      await userRef.update({garminPermissionsVerified: true});
    } else {
      console.warn("Missing required permission, clearing Garmin connection");
      await userRef.update({
        garminUserId: admin.firestore.FieldValue.delete(),
        access_token: admin.firestore.FieldValue.delete(),
        refresh_token: admin.firestore.FieldValue.delete(),
        garminPermissionsVerified: false,
      });
    }
  } catch (err) {
    console.warn(
        "Could not fetch permissions, likely Garmin delay:",
        err.response?.data || err,
    );
  }
};

module.exports = {
  getNextAssessmentInfo,
  shouldSendNotification,
  sendEmail,
  sendPush,
  createAppNotifications,
  getCurrentQuarter,
  getPreviousQuarter,
  email_footer,
  getExerciseFitnessInfo,
  sendMetaEvent,
  formatDate,
  paginate,
  chunkArray,
  generateCodeChallenge,
  generateRandomString,
  findCardioLevel,
  saveToCardio,
  isQuarterFirstMonthDeadline,
  parseFitFile,
  getValidAccessToken,
  deleteAllGarminBatchesForUser,
  scheduleGarminRegistrationCheck,
};
