/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

// const {onCall} = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const axios = require("axios");
const { FieldValue, FieldPath } = require("firebase-admin/firestore");

if (!admin.apps.length) {
  admin.initializeApp({});
}

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

const { Timestamp } = require("firebase-admin/firestore");
const {
  onDocumentCreated,
  onDocumentUpdated,
} = require("firebase-functions/v2/firestore");

// Define your secrets
const BREVO_API_KEY = defineSecret("BREVO_API_KEY");
// const LUNAR_CRM_URL = defineSecret("LUNAR_CRM_URL");
const CLIENT_ID = defineSecret("CLIENT_ID");

const ACCESS_TOKEN = defineSecret("META_ACCESS_TOKEN");
const PIXEL_ID = defineSecret("PIXEL_ID");
const CLIENT_SECRET = defineSecret("GARMIN_CLIENT_SECRET");

// import utility functions
const {
  getNextAssessmentInfo,
  shouldSendNotification,
  sendEmail,
  sendPush,
  createAppNotifications,
  getCurrentQuarter,
  getPreviousQuarter,
  email_footer,
  sendMetaEvent,
  chunkArray,
  paginate,
  getExerciseFitnessInfo,
  generateCodeChallenge,
  generateRandomString,
  isQuarterFirstMonthDeadline,
  parseFitFile,
} = require("./utils");

// For cost control, you can set the maximum number of containers that can be
// running at the same time. This helps mitigate the impact of unexpected
// traffic spikes by instead downgrading performance. This limit is a
// per-function limit. You can override the limit for each function using the
// `maxInstances` option in the function's options, e.g.
// `onRequest({ maxInstances: 5 }, (req, res) => { ... })`.
// NOTE: setGlobalOptions does not apply to functions using the v1 API. V1
// functions should each use functions.runWith({ maxInstances: 10 }) instead.
// In the v1 API, each function can only serve one request per container, so
// this will be the maximum concurrent request count.

// Create and deploy your first functions
// https://firebase.google.com/docs/functions/get-started

// publishScheduledArticlesDaily: Publish articles scheduled for the current day
exports.publishScheduledArticlesDaily = onSchedule(
  {
    schedule: "0 0 * * *",
    region: "europe-west2",
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async (event) => {
    const db = admin.firestore();

    // Get today's date in UTC
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    const day = now.getUTCDate();

    const startOfDay = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
    const endOfDay = new Date(Date.UTC(year, month, day + 1, 0, 0, 0, 0));

    try {
      // Query scheduled articles for today
      const articlesRef = db.collection("articles");
      const snapshot = await articlesRef
        .where("status", "==", "Scheduled")
        .where("published_at", ">=", startOfDay)
        .where("published_at", "<", endOfDay)
        .get();

      const batch = db.batch();

      snapshot.forEach((doc) => {
        batch.update(doc.ref, { status: "Published" });
      });

      if (!snapshot.empty) {
        await batch.commit();

        // Send push notification
        const message = {
          topic: "article_updates",
          notification: {
            title: "New Articles Published!",
            body: `Check out ${snapshot.size} new article(s): ${snapshot.docs
              .map((doc) => doc.data().title)
              .join(", ")}`,
          },
          data: {
            initialPageName: "Article",
          },
          android: {
            notification: {
              sound: "default", // Android sound
            },
          },
          apns: {
            payload: {
              aps: {
                alert: {
                  title: "New Articles Published!",
                  body: `Check out ${snapshot.size} new article(s).`,
                },
                sound: "default",
              },
            },
          },
        };

        await createAppNotifications(
          "New Articles Published!",
          `Check out ${snapshot.size} new article(s): ${snapshot.docs
            .map((doc) => doc.data().title)
            .join(", ")}`,
          "article_updates",
          [],
        );

        await admin.messaging().send(message);
      }

      console.log(`Published ${snapshot.size} scheduled articles`);
      return null;
    } catch (error) {
      console.error("Error in publishScheduledArticlesDaily:", error);
      throw error; // Let Cloud Functions handle the error
    }
  },
);

// send push notification from API call
exports.sendPushNotificationForArticle = onRequest(
  {
    cors: true,
    region: "europe-west2",
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async (req, res) => {
    // Handle pre-flight CORS
    if (req.method === "OPTIONS") return res.sendStatus(204);
    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed.");
    }

    try {
      // --- 🔑 Auth Check ---
      const authHeader = req.headers.authorization || "";
      const idToken = authHeader.startsWith("Bearer ")
        ? authHeader.split("Bearer ")[1]
        : null;

      if (!idToken) {
        return res.status(401).json({
          success: false,
          error: "Unauthorized",
          details: "Bearer token required.",
        });
      }

      await admin.auth().verifyIdToken(idToken);

      const { article_title = "" } = req.body;

      const message = {
        notification: {
          title: "New Article Published!",
          body: `Check out 1 new article(s): ${article_title}`,
        },
        topic: "article_updates",
        data: {
          initialPageName: "Article", // FlutterFlow handler expects this
          parameterData: JSON.stringify({}), // Optional, but future-proof
        },
      };

      await createAppNotifications(
        "New Article Published!",
        `Check out 1 new article(s): ${article_title}`,
        "article_updates",
        [],
      );

      await admin.messaging().send(message);

      return res.status(200).json({ success: true });
    } catch (error) {
      console.error("Push notification error:", error);
      const status = error.code?.startsWith("auth/") ? 403 : 500;

      return res.status(status).json({
        success: false,
        error: error.message || "Internal server error.",
      });
    }
  },
);

// 60 days notification
exports.notify60DaysUntilAssessment = onSchedule(
  {
    schedule: "55 11 * * *",
    region: "europe-west2",
    timeoutSeconds: 540,
    memory: "1GiB",
    secrets: [BREVO_API_KEY],
  },
  async (event) => {
    try {
      const { nextAssessment, topic } = getNextAssessmentInfo();

      if (!shouldSendNotification(nextAssessment, 60)) {
        return null;
      }

      await createAppNotifications(
        "60 days until next assessment window",
        `The next assessment window is in 60 days. Our next knowledge topic is ${topic}. Remember the answers are in the articles.`,
        "assessment_updates",
        [],
      );

      await sendEmail(
        BREVO_API_KEY.value(),
        "Prepare Now: Next Athlete Assessment in 60 Days!",
        `
          <html>
            <body>
              <p>Hi {user.name},</p>
              <p>Your next Athlete assessment window opens in exactly 60 days! The upcoming knowledge topic is \${topic}.</p>
              <p>Prepare thoroughly by reviewing the recommended articles-remember, they contain all the answers you'll need to excel and maintain or even boost your Athlete Level.</p>
              <p>Stay strong, stay informed, and stay ahead!</p>
              <p>The Athlete Team</p>
              ${email_footer}
            </body>
          </html>
        `,
        topic,
        null,
      );

      await sendPush(
        "60 days until next assessment window",
        `The next assessment window is in 60 days. Our next knowledge topic is ${topic}. Remember the answers are in the articles.`,
        "assessment_updates",
      );

      return null;
    } catch (error) {
      console.error("Error in notify60DaysUntilAssessment:", error);
      throw error;
    }
  },
);

// 30 days notification
exports.notify30DaysUntilAssessment = onSchedule(
  {
    schedule: "55 11 * * *",
    region: "europe-west2",
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async (event) => {
    try {
      const { nextAssessment } = getNextAssessmentInfo();

      if (!shouldSendNotification(nextAssessment, 30)) {
        return null;
      }

      await createAppNotifications(
        "30 days until next assessment window",
        "30-day countdown to the next assessment window!",
        "assessment_updates",
        [],
      );

      await sendPush(
        "30 days until next assessment window",
        "30-day countdown to the next assessment window!",
        "assessment_updates",
      );

      return null;
    } catch (error) {
      console.error("Error in notify30DaysUntilAssessment:", error);
      throw error;
    }
  },
);

// 14 days notification
exports.notify14DaysUntilAssessment = onSchedule(
  {
    schedule: "55 11 * * *",
    region: "europe-west2",
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async (event) => {
    try {
      const { nextAssessment } = getNextAssessmentInfo();

      if (!shouldSendNotification(nextAssessment, 14)) {
        return null;
      }

      await createAppNotifications(
        "14 days before next assessment",
        `14 days until your next assessment window`,
        "assessment_updates",
        [],
      );

      await sendPush(
        "14 days before next assessment",
        "14 days until your next assessment window",
      );

      return null;
    } catch (error) {
      console.error("Error in notify14DaysUntilAssessment:", error);
      throw error;
    }
  },
);

// 7 days notification
exports.notify7DaysUntilAssessment = onSchedule(
  {
    schedule: "55 11 * * *",
    region: "europe-west2",
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async (event) => {
    try {
      const { nextAssessment } = getNextAssessmentInfo();

      if (!shouldSendNotification(nextAssessment, 7)) {
        return null;
      }

      await createAppNotifications(
        "7 days until next assessment window",
        "One-week alert! Get ready for your upcoming assessment",
        "assessment_updates",
        [],
      );

      await sendPush(
        "7 days until next assessment window",
        "One-week alert! Get ready for your upcoming assessment.",
        "assessment_updates",
      );

      return null;
    } catch (error) {
      console.error("Error in notify7DaysUntilAssessment:", error);
      throw error;
    }
  },
);

// Assessment window opens notification
exports.notifyAssessmentWindowOpens = onSchedule(
  {
    schedule: "30 0 1 * *", // Runs at midnight UTC on the 1st of every month
    region: "europe-west2",
    timeoutSeconds: 540,
    memory: "1GiB",
    secrets: [BREVO_API_KEY],
  },
  async (event) => {
    try {
      const now = new Date();
      const currentMonth = now.getUTCMonth() + 1; // 1-12, UTC

      // Define quarter start months
      const quarterStartMonths = [1, 4, 7, 10];

      // Check if current month is a quarter start month
      if (!quarterStartMonths.includes(currentMonth)) {
        console.log(`Month ${currentMonth} is not a quarter start month`);
        return null;
      }

      // Find current quarter based on start month
      const currentQuarter = getCurrentQuarter();

      if (!currentQuarter) {
        return null;
      }

      await createAppNotifications(
        "Assessent window starts",
        "The assessmnent window is open - good luck",
        "assessment_updates",
        [],
      );

      await sendEmail(
        BREVO_API_KEY.value(),
        "Athlete Assessment Window Now Open - Good Luck!",
        `
          <html>
            <body>
              <p>Hi {user.name},</p>
              <p>Your Athlete assessment window is now officially open! This is your chance to measure your progress and maintain or elevate your Athlete Level.</p>
              <p>Dive in, give it your best, and achieve your personal fitness goals.</p>
              <p>Good luck!</p>
              <p>The Athlete Team</p>
              ${email_footer}
            </body>
          </html>
        `,
        "",
        null,
      );

      await sendPush(
        "Assessment window starts",
        "The assessment window is open - good luck",
        "assessment_updates",
      );

      return null;
    } catch (error) {
      console.error("Error in notifyAssessmentWindowOpens:", error);
      throw error;
    }
  },
);

exports.getUsersWithCurrentLevels = onRequest(
  {
    cors: true,
    region: "europe-west2",
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async (req, res) => {
    if (req.method === "OPTIONS") return res.status(204).send("");

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res
        .status(401)
        .json({ error: "Unauthorized", message: "Bearer token required." });
    }
    const idToken = authHeader.split("Bearer ")[1];

    try {
      await admin.auth().verifyIdToken(idToken);
      const db = admin.firestore();

      const pageSize = parseInt(req.query.pageSize, 10) || 10;
      const pageToken = req.query.pageToken || null;
      const pageNumber = req.query.pageNumber
        ? parseInt(req.query.pageNumber, 10)
        : null;
      const direction = req.query.direction || "next";
      const category = (req.query.category || "").trim();
      const searchField = (req.query.searchField || "").trim().toLowerCase();

      // 1️⃣ Fetch all users first (filtered by role/type)
      const allSnap = await db
        .collection("users")
        .where("role", "==", "User")
        .get();
      // 1️⃣ Fetch all users first (filtered by role/type)
      let usersArray = allSnap.docs.map((doc) => ({
        id: doc.id,
        ref: doc.ref,
        ...doc.data(),
      }));

      // Apply category filter if provided
      if (category) {
        usersArray = usersArray.filter(
          (u) => (u.type || "").toLowerCase() === category.toLowerCase(),
        );
      }

      // Apply search filter if provided
      if (searchField) {
        usersArray = usersArray.filter(
          (u) =>
            (u.display_name || "").toLowerCase().includes(searchField) ||
            (u.email || "").toLowerCase().includes(searchField),
        );
      }

      // 2️⃣ Paginate users
      const paged = paginate(usersArray, {
        pageSize,
        pageToken,
        pageNumber,
        direction,
        tokenKeyExtractor: (item) => item.id,
      });

      // 3️⃣ Resolve current assessment for each user
      const currentYear = new Date().getUTCFullYear();
      const currentQuarter = getCurrentQuarter();
      // const {prevQuarter, prevYear} = getPreviousQuarter(
      //     currentQuarter,
      //     currentYear,
      // );

      const users = await Promise.all(
        paged.data.map(async (user) => {
          let assessmentData = null;
          let assessmentDoc = null;

          try {
            // 1️⃣ Current quarter assessment
            const assessmentSnap = await db
              .collection("assessments")
              .where("user_id", "==", user.ref)
              .where("year", "==", currentYear)
              .where("quarter.month", "==", currentQuarter.month)
              .limit(1)
              .get();

            if (!assessmentSnap.empty) {
              assessmentDoc = assessmentSnap.docs[0];
            } else {
              console.log("- No assessment found for current quarter");
            }

            // 2️⃣ Fallback to previous quarter if incomplete
            if (!assessmentDoc || assessmentDoc.data().is_completed !== true) {
              const prevSnap = await db
                .collection("assessments")
                .where("user_id", "==", user.ref)
                .where("is_completed", "==", true)
                .orderBy("created_at", "desc")
                .limit(1)
                .get();
              if (!prevSnap.empty) {
                assessmentDoc = prevSnap.docs[0];
                console.log(`Fallback assessment found: ${assessmentDoc.id}`);
              } else {
                console.log(
                  "No fallback assessment found for previous quarter.",
                );
              }
            }

            // 3️⃣ Resolve sub-assessments (cardio/strength/knowledge)
            if (assessmentDoc) {
              const assessment = assessmentDoc.data();
              const isValidRef = (ref) => ref && typeof ref.get === "function";

              console.log(
                `- Fetching sub-assessments: cardio_id: ${assessment.cardio_id?.id}, strength_id: ${assessment.strength_id?.id}, knowledge_id: ${assessment.knowledge_id?.id}`,
              );

              const [cardioSnap, strengthSnap, knowledgeSnap] =
                await Promise.all([
                  isValidRef(assessment.cardio_id)
                    ? assessment.cardio_id.get()
                    : null,
                  isValidRef(assessment.strength_id)
                    ? assessment.strength_id.get()
                    : null,
                  isValidRef(assessment.knowledge_id)
                    ? assessment.knowledge_id.get()
                    : null,
                ]);

              assessmentData = {
                cardio_level: cardioSnap?.exists
                  ? cardioSnap.data().level
                  : null,
                strength_level: strengthSnap?.exists
                  ? strengthSnap.data().level
                  : null,
                knowledge_level: knowledgeSnap?.exists
                  ? knowledgeSnap.data().level
                  : null,
              };
            } else {
              console.log("- No assessment data resolved for this user");
            }

            return {
              user_id: user.id,
              name: user.display_name || null,
              email: user.email || null,
              photo_url: user.photo_url || null,
              athlete_level: user.athlete_level ?? null,
              current_assessment: assessmentData,
              created_time:
                user.created_time?.toDate?.().toISOString?.() ||
                user.created_at?.toDate?.().toISOString?.(),
              is_banned: user.is_banned ?? false,
              type: user.type || null,
            };
          } catch (err) {
            console.error(
              `❌ Error processing user ${user.display_name}:`,
              err,
            );
            return null;
          }
        }),
      );

      return res.status(200).json({
        users,
        nextPageToken: paged.nextPageToken,
        prevPageToken: paged.prevPageToken,
        totalCount: paged.totalCount,
        totalPages: paged.totalPages,
        currentPage: paged.currentPage,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message, details: err });
    }
  },
);

// ✅ getAssessmentStatistics
exports.getAssessmentStatistics = onRequest(
  { cors: true, region: "europe-west2", timeoutSeconds: 540, memory: "1GiB" },
  async (req, res) => {
    if (req.method === "OPTIONS") return res.status(204).send("");

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res
        .status(401)
        .json({ error: "Unauthorized", message: "Bearer token required." });
    }
    const idToken = authHeader.split("Bearer ")[1];
    try {
      await admin.auth().verifyIdToken(idToken);
      const db = admin.firestore();
      const snapshot = await db.collection("assessments").get();
      if (snapshot.empty) {
        return res
          .status(200)
          .json({ statistics: [], message: "No assessments found" });
      }

      const stats = {};

      snapshot.docs.forEach((doc) => {
        const data = doc.data();
        const { isOnboarding, is_completed, year, quarter } = data;
        if (!year || typeof is_completed !== "boolean") return;

        // Month calculation
        const month = isOnboarding
          ? new Date(
              data.created_at?.toDate?.() || data.created_at,
            ).getUTCMonth() + 1
          : quarter?.month;

        const key = isOnboarding
          ? `${year}-${String(month).padStart(2, "0")}`
          : `${year}-${quarter.label}`;

        if (!stats[key]) {
          stats[key] = {
            id_ref: key,
            assessment: isOnboarding
              ? `Onboarding ${year}-${String(month).padStart(2, "0")}`
              : `Assessment ${quarter.label}/${year}`,
            year,
            month: isOnboarding ? month : undefined,
            assessmentStartDate: new Date(
              Date.UTC(year, (month || 1) - 1, 1),
            ).toISOString(),
            quarter: quarter || null,
            completed_count: 0,
            not_completed_count: 0,
            total_count: 0,
            onboarding: !!isOnboarding,
          };
        }

        // Only count if is_completed is boolean
        if (typeof is_completed === "boolean") {
          is_completed
            ? stats[key].completed_count++
            : stats[key].not_completed_count++;
          stats[key].total_count++;
        }
      });

      const combined = Object.values(stats);
      combined.sort((a, b) =>
        a.assessmentStartDate > b.assessmentStartDate ? -1 : 1,
      );

      const {
        pageSize = 10,
        pageToken = null,
        pageNumber = null,
        direction,
      } = req.query;
      const paged = paginate(combined, {
        pageSize: Number(pageSize),
        pageToken,
        pageNumber: pageNumber ? Number(pageNumber) : null,
        direction,
        tokenKeyExtractor: (item) => item.id_ref,
      });
      const totalAll = combined.reduce((sum, a) => sum + a.total_count, 0);
      console.log("Total across all grouped assessments:", totalAll);

      return res.status(200).json(paged);
    } catch (err) {
      return res.status(500).json({ error: err.message, details: err });
    }
  },
);

// ✅ getUsersAssessment
exports.getUsersAssessment = onRequest(
  { cors: true, region: "europe-west2", timeoutSeconds: 540, memory: "1GiB" },
  async (req, res) => {
    if (req.method === "OPTIONS") return res.status(204).send("");

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res
        .status(401)
        .json({ error: "Unauthorized", message: "Bearer token required." });
    }

    const idToken = authHeader.split("Bearer ")[1];
    try {
      await admin.auth().verifyIdToken(idToken);
      const db = admin.firestore();

      const {
        year,
        month,
        pageSize = 10,
        pageToken = null,
        pageNumber = null,
        direction,
        userType, // <-- 'Policy Holder' or 'Non Policy Holder'
        searchField = "",
      } = req.query;

      const searchLower = (searchField || "").trim().toLowerCase();

      if (!year) return res.status(400).json({ error: "Year is required." });

      const assessmentsSnapshot = await db.collection("assessments").get();
      const filteredAssessments = [];

      assessmentsSnapshot.docs.forEach((doc) => {
        const data = doc.data();
        const { isOnboarding, year: docYear, quarter, is_completed } = data;
        if (!docYear || typeof is_completed !== "boolean") return;

        const createdDate = data.created_at?.toDate
          ? data.created_at.toDate()
          : new Date(data.created_at);
        if (isNaN(createdDate)) return;

        const createdMonth = createdDate.getUTCMonth() + 1; // 1-12
        const effectiveMonth = isOnboarding ? createdMonth : quarter?.month;

        if (docYear === parseInt(year) && effectiveMonth === Number(month)) {
          filteredAssessments.push({
            ...data,
            month: effectiveMonth,
            assessment_start_date: new Date(
              Date.UTC(docYear, (effectiveMonth || 1) - 1, 1),
            ).toISOString(),
          });
        }
      });

      // Compute counts
      const currentCompletedCount = filteredAssessments.filter(
        (a) => a.is_completed,
      ).length;
      const currentNotCompletedCount = filteredAssessments.filter(
        (a) => !a.is_completed,
      ).length;

      // Process assessments in chunks
      const users = [];
      const assessmentChunks = chunkArray(filteredAssessments, 10);

      for (const chunk of assessmentChunks) {
        for (const assessment of chunk) {
          const userRef = assessment.user_id;
          if (!userRef || typeof userRef.get !== "function") continue;

          const userSnap = await userRef.get();
          if (!userSnap.exists) continue;

          const user = userSnap.data();
          // --- SEARCH FILTER ---
          if (searchLower) {
            const name = (user.display_name || "").toLowerCase();
            const email = (user.email || "").toLowerCase();
            if (!name.includes(searchLower) && !email.includes(searchLower)) {
              continue;
            }
          }

          // --- FILTER USERS BY TYPE ---
          let userTypeFilter = userType;
          if (userTypeFilter === "Policy Holder") {
            userTypeFilter = "policy_holder";
          } // convert

          if (userTypeFilter && user.type !== userTypeFilter) continue;
          console.log(
            "User:",
            user.email,
            "Type:",
            user.type,
            "userTypeFilter:",
            userTypeFilter,
          );

          if (userTypeFilter === "policy_holder") {
            if (!user.email) continue;

            const normalizedEmail = user.email.toLowerCase();

            const policiesSnap = await db
              .collection("policies")
              .where("user_email", "==", normalizedEmail)
              .where("status", "==", "Active") // make sure this matches exactly
              .limit(1)
              .get();

            if (policiesSnap.empty) continue;
            console.log(
              "User:",
              user.email,
              "| Type:",
              user.type,
              "| userTypeFilter:",
              userTypeFilter,
              "| Has active policy:",
              !policiesSnap.empty,
            );
          }

          const assessmentCreatedAt = assessment.created_at?.toDate
            ? assessment.created_at.toDate()
            : new Date(assessment.created_at);

          // Fetch previous completed assessment
          const prevSnap = await db
            .collection("assessments")
            .where("user_id", "==", userRef)
            .where("is_completed", "==", true)
            .where("created_at", "<", Timestamp.fromDate(assessmentCreatedAt))
            .orderBy("created_at", "desc")
            .limit(1)
            .get();

          const previousLevel = !prevSnap.empty
            ? prevSnap.docs[0].data().level
            : null;

          users.push({
            id_ref: userSnap.id,
            user_id: userSnap.id,
            name: user.display_name || null,
            email: user.email || null,
            profile_url: user.photo_url || null,
            athlete_level: assessment.level || null,
            previous_level: previousLevel,
            current_assessment: assessment,
          });
        }
      }

      const paged = paginate(users, {
        pageSize: Number(pageSize),
        pageToken,
        pageNumber: pageNumber ? Number(pageNumber) : null,
        direction,
        tokenKeyExtractor: (item) => item.id_ref,
      });

      return res.status(200).json({
        ...paged,
        current_completed_count: currentCompletedCount,
        not_completed_count: currentNotCompletedCount,
        total_assessments: currentCompletedCount + currentNotCompletedCount,
        assessment_start_date:
          filteredAssessments[0]?.assessment_start_date || null,
      });
    } catch (error) {
      return res.status(500).json({ error: error.message, details: error });
    }
  },
);

exports.createQuarterlyAssessments = onSchedule(
  {
    schedule: "0 0 1 * *", // Runs at midnight UTC on the 1st of every month
    region: "europe-west2",
    timeoutSeconds: 540,
    memory: "1GiB",
    timeZone: "Etc/UTC", // Explicitly set to UTC (GMT)
  },
  async (event) => {
    try {
      const db = admin.firestore();
      const now = new Date();
      const currentMonth = now.getUTCMonth() + 1; // 1-12, UTC
      const currentYear = now.getUTCFullYear(); // UTC

      // Define quarter start months
      const quarterStartMonths = [1, 4, 7, 10];

      // Check if current month is a quarter start month
      if (!quarterStartMonths.includes(currentMonth)) {
        console.log(`Month ${currentMonth} is not a quarter start month`);
        return null;
      }

      // Find current quarter based on start month
      const currentQuarter = getCurrentQuarter();

      if (!currentQuarter) {
        console.log(`No quarter found for month ${currentMonth}`);
        return null;
      }

      // Get all assessments who onboarding is completed
      const assessmentSnapshot = await db
        .collection("assessments")
        .where("isOnboarding", "==", true)
        .get();

      if (assessmentSnapshot.empty) {
        console.log("No users found with role 'User'");
        return null;
      }

      // Create a batch for Firestore operations
      const batch = db.batch();

      // Process each user
      assessmentSnapshot.forEach((assessmentDoc) => {
        const data = assessmentDoc.data();
        const userRef = data.user_id;

        if (!userRef) {
          console.warn(
            `Skipping assessment ${assessmentDoc.id} - missing user_id`,
          );
          return;
        }

        const assessmentRef = db.collection("assessments").doc();
        batch.set(assessmentRef, {
          user_id: userRef,
          created_at: FieldValue.serverTimestamp(),
          year: currentYear,
          quarter: {
            label: currentQuarter.label,
            month: currentQuarter.month,
            type: currentQuarter.type,
          },
          is_completed: false,
          isOnboarding: false,
        });
      });

      // Commit the batch
      await batch.commit();
      console.log(
        `Created ${assessmentSnapshot.size} assessment documents for ${currentQuarter.label}/${currentYear}`,
      );

      return null;
    } catch (error) {
      console.error("Error in createQuarterlyAssessments:", error);
      throw error; // Let Cloud Functions handle the error
    }
  },
);

// This function runs at the end of each month and updates the level field of incomplete assessments for quarter months
exports.updateIncompleteAssessments = onSchedule(
  {
    schedule: "55 23 28-31 * *", // Runs at 23:55 UTC on days 28-31 of each month
    region: "europe-west2",
    timeoutSeconds: 540,
    memory: "1GiB",
    timeZone: "Etc/UTC",
  },
  async (event) => {
    const db = admin.firestore();
    const now = new Date();
    const currentMonth = now.getUTCMonth() + 1; // 1-12
    const currentDay = now.getUTCDate();
    const currentYear = now.getUTCFullYear();

    // Only run on quarter months
    const quarterMonths = [3, 6, 9, 12];
    if (!quarterMonths.includes(currentMonth)) return null;

    // Check if today is the last day of the month
    const tomorrow = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
    );
    if (tomorrow.getUTCDate() !== 1) {
      console.log(
        `Today (${currentDay}) is not the last day of the month. Exiting.`,
      );
      return null;
    }

    try {
      const assessmentsSnapshot = await db
        .collection("assessments")
        .where("quarter.month", "==", currentMonth)
        .where("year", "==", currentYear)
        .where("is_completed", "==", false)
        .get();

      if (assessmentsSnapshot.empty) {
        console.log("No incomplete assessments found for this quarter month.");
        return null;
      }

      const batch = db.batch();
      const processedUsers = new Set(); // Track processed users

      const notifications = []; // only userId + message

      for (const doc of assessmentsSnapshot.docs) {
        const data = doc.data();
        const userRef = data.user_id;
        if (!userRef || typeof userRef.get !== "function") continue;

        const userSnap = await userRef.get();
        if (!userSnap.exists) continue;

        const userData = userSnap.data();
        const userId = userSnap.id;

        if (processedUsers.has(userId)) continue;
        processedUsers.add(userId);

        // Update missed + athlete_level
        let missed = userData.consecutive_missed_assessments || 0;
        missed += 1;
        let athleteLevel = userData.athlete_level || null;

        if (missed >= 3 && athleteLevel && athleteLevel > 1) {
          athleteLevel -= 1;
          missed = 0; // reset after penalty
        }

        // Personalized message
        let notificationMsg = "";
        if (missed === 1) {
          notificationMsg = `Your Athlete level remains at ${
            athleteLevel || 1
          }. You can skip one more assessment before your level may decrease.`;
        } else if (missed === 2) {
          notificationMsg = `Your Athlete level remains at ${
            athleteLevel || 1
          }. Missing the next assessment will reduce your level by 1.`;
        } else if (missed >= 3) {
          notificationMsg = `Your Athlete level has been reduced to ${
            athleteLevel || 1
          }. Find out why in this article.`;
        }

        if (userData.assessment_updates && notificationMsg) {
          notifications.push({ userId, message: notificationMsg });
        }

        // Update user record
        batch.update(userRef, {
          consecutive_missed_assessments: missed,
          athlete_level: athleteLevel,
        });

        // Update assessment with level at close
        batch.update(doc.ref, { level: athleteLevel });
      }

      await batch.commit();

      // Send notifications
      if (notifications.length > 0) {
        const notificationTitle = "Assessment window closed!";
        const type = "assessment_updates";

        await createAppNotifications(
          notificationTitle,
          null,
          type,
          notifications,
        );

        await sendPush(
          notificationTitle,
          null,
          "assessment_updates",
          {},
          null,
          notifications.map((n) => ({
            userId: n.userId,
            title: notificationTitle,
            body: n.message,
          })),
        );
      }

      return null;
    } catch (error) {
      console.error("Error in updateIncompleteAssessments:", error);
      throw error;
    }
  },
);

// 15 days until assessment window closes (if not completed)
exports.notify15DaysUntilAssessmentCloses = onSchedule(
  {
    schedule: "55 11 * * *",
    region: "europe-west2",
    timeoutSeconds: 540,
    memory: "1GiB",
    secrets: ["BREVO_API_KEY"],
  },
  async (event) => {
    const now = new Date();
    const currentYear = now.getUTCFullYear();
    const currentMonth = now.getUTCMonth() + 1;

    const currentQuarter = getCurrentQuarter();
    if (!currentQuarter) return null;

    const assessmentCloseDate = new Date(
      Date.UTC(currentYear, currentMonth, 0, 23, 59, 59),
    );
    const today = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const diffDays = Math.floor(
      (assessmentCloseDate - today) / (1000 * 60 * 60 * 24),
    );
    if (diffDays !== 15) return null;

    try {
      const db = admin.firestore();

      // 1️⃣ Fetch all incomplete assessments for current quarter
      const assessmentsSnapshot = await db
        .collection("assessments")
        .where("quarter.month", "==", currentQuarter.month)
        .where("year", "==", currentYear)
        .where("is_completed", "==", false)
        .get();

      if (assessmentsSnapshot.empty) return null;

      const processedUsers = new Set();
      const targetedUsersOnboarding = []; // onboarding users → old notification
      const userRecords = []; // non-onboarding users with { userId, email, display_name }

      for (const doc of assessmentsSnapshot.docs) {
        const data = doc.data();
        const userRef = data.user_id;
        if (!userRef || typeof userRef.get !== "function") continue;

        const userSnap = await userRef.get();
        if (!userSnap.exists) continue;

        const userId = userSnap.id;
        const userData = userSnap.data() || {};
        const userEmail = userData.email;

        if (processedUsers.has(userId) || !userData.assessment_updates) {
          continue;
        }
        processedUsers.add(userId);

        if (data.isOnboarding === true) {
          targetedUsersOnboarding.push(userId);
        } else if (userEmail) {
          userRecords.push({
            userId,
            email: userEmail,
            display_name: userData.display_name,
          });
        }
      }

      // 2️⃣ Send push notifications to onboarding users
      if (targetedUsersOnboarding.length > 0) {
        const title = "15 days until assessment window closes";
        const body =
          "Only 15 days left to complete your assessment. Don't miss out!";

        await createAppNotifications(
          title,
          body,
          "assessment_updates",
          targetedUsersOnboarding.map((userId) => ({ userId, message: body })),
        );

        await sendPush(
          title,
          body,
          "assessment_updates",
          {},
          targetedUsersOnboarding,
        );
      }

      if (userRecords.length === 0) return null;

      // 3️⃣ Policies check for non-onboarding users
      const year = now.getUTCFullYear();
      const month = now.getUTCMonth();
      const day = now.getUTCDate();
      const startOfDay = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
      const endOfDay = new Date(Date.UTC(year, month, day, 23, 59, 59, 999));

      const emailChunks = [];
      const allEmails = userRecords.map((u) => u.email);
      for (let i = 0; i < allEmails.length; i += 10) {
        emailChunks.push(allEmails.slice(i, i + 10));
      }

      const policies = [];
      for (const chunk of emailChunks) {
        const snap = await db
          .collection("policies")
          .where("status", "==", "Active")
          .where("user_email", "in", chunk)
          .where("starting_date", "<=", endOfDay)
          .where("ending_date", ">=", startOfDay)
          .get();
        policies.push(...snap.docs.map((d) => d.data()));
      }

      if (policies.length === 0) return null;

      // 4️⃣ Merge user info with policy info
      const updatedUsers = userRecords
        .map((user) => {
          const policy = policies.find(
            (p) => p.user_email === user.email && p.pendingAmount > 0,
          );
          if (!policy) return null;
          return {
            ...user,
            locked_amount: policy.pendingAmount,
          };
        })
        .filter(Boolean);

      if (updatedUsers.length === 0) return null;

      // 5️⃣ Send emails individually (personalized)
      for (const { email, display_name, locked_amount } of updatedUsers) {
        const roundedAmount = Number(locked_amount).toFixed(2);
        await sendEmail(
          BREVO_API_KEY.value(), // ✅ secret manager
          `15 days left to bank £${roundedAmount}`,
          `
            <html>
              <body>
                <p>Hi ${display_name},</p>
                <p>You've got £${roundedAmount} waiting. Complete your next assessment within 15 days to bank it.</p>
                <p>The Athlete Team</p>
                ${email_footer}
              </body>
            </html>
          `,
          "",
          [{ email }],
        );
      }

      // 6️⃣ Build notifications + push
      const perUserMessages = [];
      const notificationTitle = `15 days until assessment window closes`;

      for (const { userId, locked_amount } of updatedUsers) {
        if (!locked_amount || locked_amount <= 0) continue;
        const roundedAmount = Number(locked_amount).toFixed(2);

        const body = `⏳ 15 days left to bank £${roundedAmount}. Don't lose it - book your assessment.`;

        perUserMessages.push({ userId, title: notificationTitle, body });
      }

      if (perUserMessages.length > 0) {
        await createAppNotifications(
          notificationTitle,
          null,
          "assessment_updates",
          perUserMessages.map(({ userId, body }) => ({
            userId,
            message: body,
          })),
        );

        await sendPush({ perUserMessages });
      }

      return null;
    } catch (error) {
      console.error("Error notifying users:", error);
      return null;
    }
  },
);

// 7 days until assessment window closes (if not completed)
exports.notify7DaysUntilAssessmentCloses = onSchedule(
  {
    schedule: "55 11 * * *",
    region: "europe-west2",
    timeoutSeconds: 540,
    memory: "1GiB",
    secrets: ["BREVO_API_KEY"],
  },
  async (event) => {
    const now = new Date();
    const currentYear = now.getUTCFullYear();
    const currentMonth = now.getUTCMonth() + 1;

    // Find the current quarter
    const currentQuarter = getCurrentQuarter();
    if (!currentQuarter) return null;

    // Assessment window closes at the end of this month
    const assessmentCloseDate = new Date(
      Date.UTC(currentYear, currentMonth, 0, 23, 59, 59),
    );
    const today = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );

    const diffDays = Math.floor(
      (assessmentCloseDate - today) / (1000 * 60 * 60 * 24),
    );
    if (diffDays !== 7) return null; // Only run 7 days before month end

    try {
      const db = admin.firestore();
      const BREVO_API_KEY_VALUE = BREVO_API_KEY.value();

      // 1️⃣ Fetch incomplete assessments
      const assessmentsSnapshot = await db
        .collection("assessments")
        .where("quarter.month", "==", currentQuarter.month)
        .where("year", "==", currentYear)
        .where("is_completed", "==", false)
        .where("isOnboarding", "==", false)
        .get();

      if (assessmentsSnapshot.empty) return null;

      const processedUsers = new Set();
      const userFetches = assessmentsSnapshot.docs.map(async (doc) => {
        const data = doc.data();
        const userRef = data.user_id;
        if (!userRef || typeof userRef.get !== "function") return null;

        const userSnap = await userRef.get();
        if (!userSnap.exists) return null;

        const userId = userSnap.id;
        if (processedUsers.has(userId)) return null;
        processedUsers.add(userId);

        const userData = userSnap.data() || {};
        if (!userData.email || !userData.assessment_updates) return null;

        return {
          userId,
          email: userData.email,
          name: userData.display_name,
        };
      });

      const userRecords = (await Promise.all(userFetches)).filter(Boolean);
      if (!userRecords.length) return null;

      // 2️⃣ Policies lookup
      const year = now.getUTCFullYear();
      const month = now.getUTCMonth();
      const day = now.getUTCDate();

      const startOfDay = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
      const endOfDay = new Date(Date.UTC(year, month, day, 23, 59, 59, 999));

      // Split into chunks of 10 emails for Firestore `in` query
      const emailChunks = [];
      const allEmails = userRecords.map((u) => u.email);
      for (let i = 0; i < allEmails.length; i += 10) {
        emailChunks.push(allEmails.slice(i, i + 10));
      }

      const policies = [];
      for (const chunk of emailChunks) {
        const snap = await db
          .collection("policies")
          .where("status", "==", "Active")
          .where("user_email", "in", chunk)
          .where("starting_date", "<=", endOfDay)
          .where("ending_date", ">=", startOfDay)
          .get();

        policies.push(...snap.docs.map((d) => d.data()));
      }

      if (!policies.length) return null;

      // 3️⃣ Build updated users with locked_amount
      const updatedUsers = userRecords
        .map((user) => {
          // find the corresponding policy for this user's email
          const policy = policies.find(
            (p) => p.user_email === user.email && p.pendingAmount > 0,
          );
          if (!policy) return null;

          return {
            ...user,
            locked_amount: policy.pendingAmount || 0, // from policies table
          };
        })
        .filter(Boolean);

      if (!updatedUsers.length) return null;

      // 4️⃣ Send email to each user
      for (const { email, display_name, locked_amount } of updatedUsers) {
        const roundedAmount = Number(locked_amount).toFixed(2);
        await sendEmail(
          BREVO_API_KEY_VALUE,
          `Don't lose your £${roundedAmount} rebate`,
          `
            <html>
              <body>
                <p>Hi ${display_name},</p>
                <p>Time's almost up — 7 days left to bank £${roundedAmount}. Complete your assessment to keep what you've earned.</p>
                <p>The Athlete Team</p>
                ${email_footer}
              </body>
            </html>
          `,
          "",
          [{ email }],
        );
      }

      // 5️⃣ Build push notifications
      const notificationTitle = "7 days until assessment window closes";
      const perUserMessages = updatedUsers.map((u) => {
        const roundedAmount = Number(u.locked_amount).toFixed(2);
        return {
          userId: u.userId,
          title: notificationTitle,
          body: `Last chance! 7 days to bank £${roundedAmount}. Complete your assessment.`,
        };
      });

      if (perUserMessages.length) {
        await createAppNotifications(
          notificationTitle,
          null,
          "assessment_updates",
          perUserMessages.map(({ userId, body }) => ({
            userId,
            message: body,
          })),
        );

        await sendPush({ perUserMessages }); // ✅ correct usage
      }

      return null;
    } catch (err) {
      console.error("notify7DaysUntilAssessmentCloses failed:", err);
      return null;
    }
  },
);

// 2 days until assessment window closes (if not completed)
exports.notify2DaysUntilAssessmentCloses = onSchedule(
  {
    schedule: "55 11 * * *",
    region: "europe-west2",
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async (event) => {
    const now = new Date();
    const currentYear = now.getUTCFullYear();
    const currentMonth = now.getUTCMonth() + 1;

    // Find the current quarter
    const currentQuarter = getCurrentQuarter();

    if (!currentQuarter) return null;

    // Assessment window closes at the end of this month
    const assessmentCloseDate = new Date(
      Date.UTC(currentYear, currentMonth, 0, 23, 59, 59),
    );
    const today = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );

    // If today is 2 days before the end of the month
    const diffDays = Math.floor(
      (assessmentCloseDate - today) / (1000 * 60 * 60 * 24),
    );
    if (diffDays !== 2) return null;

    try {
      const db = admin.firestore();

      // Get all incomplete assessments for this quarter
      const assessmentsSnapshot = await db
        .collection("assessments")
        .where("quarter.month", "==", currentQuarter.month)
        .where("year", "==", currentYear)
        .where("is_completed", "==", false)
        .get();

      if (assessmentsSnapshot.empty) return null;

      const processedUsers = [];

      const notificationMsg =
        "Urgent reminder: Just 2 days remaining to finish your assessment!";
      // Collect user IDs and send personalized notifications
      for (const doc of assessmentsSnapshot.docs) {
        const data = doc.data();
        const userRef = data.user_id;
        if (!userRef || typeof userRef.get !== "function") continue;

        const userSnap = await userRef.get();
        if (!userSnap.exists) continue;

        const userId = userSnap.id;
        const userData = userSnap.data() || {};

        // Skip if user already processed
        if (processedUsers.includes(userId) || !userData.assessment_updates) {
          continue;
        }

        processedUsers.push(userId);
      }

      // Create a unique notification record for this user
      if (processedUsers.length > 0) {
        await createAppNotifications(
          "2 days until assessment window closes",
          null,
          "assessment_updates",
          processedUsers.map((id) => ({
            userId: id,
            message: notificationMsg,
          })),
        );

        await sendPush(
          "2 days until assessment window closes",
          notificationMsg,
          "assessment_updates",
          {},
          processedUsers,
        );
      }

      return null;
    } catch (err) {
      console.error("notify2DaysUntilAssessmentCloses failed:", err);
    }
  },
);

// Last day assessment window closes (if not completed)
exports.notifyLastDayAssessmentCloses = onSchedule(
  {
    schedule: "55 11 * * *",
    region: "europe-west2",
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async (event) => {
    const now = new Date();

    if (!isQuarterFirstMonthDeadline()) {
      console.log(
        "Not the last day of the first month of the quarter. Exiting.",
      );
      return null;
    }

    const currentYear = now.getUTCFullYear();
    const currentQuarter = getCurrentQuarter();
    if (!currentQuarter) return null;

    try {
      const db = admin.firestore();

      // 1. Assessments check
      const assessmentsSnapshot = await db
        .collection("assessments")
        .where("quarter.month", "==", currentQuarter.month)
        .where("year", "==", currentYear)
        .where("is_completed", "==", false)
        .where("isOnboarding", "==", false)
        .get();

      if (assessmentsSnapshot.empty) return null;

      const processedUsers = new Set();

      const userFetches = assessmentsSnapshot.docs.map(async (doc) => {
        const data = doc.data();
        const userRef = data.user_id;
        if (!userRef || typeof userRef.get !== "function") return null;

        const userSnap = await userRef.get();
        if (!userSnap.exists) return null;

        const userId = userSnap.id;
        if (processedUsers.has(userId)) return null;

        const userData = userSnap.data() || {};
        if (
          !userData.email ||
          !userData.assessment_updates ||
          userData.type !== "policy_holder"
        ) {
          return null;
        }

        processedUsers.add(userId);
        return { userId, email: userData.email };
      });

      const userRecords = (await Promise.all(userFetches)).filter(Boolean);
      if (userRecords.length === 0) return null;

      // 2. Policies check
      const startOfDay = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate(),
          0,
          0,
          0,
          0,
        ),
      );
      const endOfDay = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate(),
          23,
          59,
          59,
          999,
        ),
      );

      // Split emails into chunks of 10 for Firestore `in` query
      const allEmails = userRecords.map((u) => u.email);
      const emailChunks = [];
      for (let i = 0; i < allEmails.length; i += 10) {
        emailChunks.push(allEmails.slice(i, i + 10));
      }

      const policies = [];
      for (const chunk of emailChunks) {
        const snap = await db
          .collection("policies")
          .where("status", "==", "Active")
          .where("user_email", "in", chunk)
          .where("starting_date", "<=", endOfDay)
          .where("ending_date", ">=", startOfDay)
          .get();
        policies.push(...snap.docs.map((d) => d.data()));
      }

      if (policies.length === 0) return null;

      const updatedUsers = userRecords
        .map((u) => {
          const policy = policies.find(
            (p) => p.user_email === u.email && p.pendingAmount > 0,
          );
          if (!policy) return null;
          return {
            ...u,
            locked_amount: policy.pendingAmount || 0,
          };
        })
        .filter(Boolean);

      // 3. Build notifications
      const perUserMessages = [];
      const notificationTitle = `Last day assessment window closes`;

      for (const { locked_amount, userId } of updatedUsers) {
        if (!locked_amount || locked_amount <= 0) continue;
        const roundedAmount = Number(locked_amount).toFixed(2);

        const body = `Today's the day: bank £${roundedAmount} by completing your assessment.`;

        perUserMessages.push({
          userId,
          title: notificationTitle,
          body,
        });
      }

      if (perUserMessages.length > 0) {
        await createAppNotifications(
          notificationTitle,
          null,
          "assessment_updates",
          perUserMessages.map(({ userId, body }) => ({
            userId,
            message: body,
          })),
        );

        await sendPush({
          perUserMessages, // directly pass the array
        });
      }

      return null;
    } catch (err) {
      console.error("notifyLastDayAssessmentCloses failed:", err);
      return null;
    }
  },
);

// Notify users with incomplete assessments in the first day of the second quarter month,
// only in Feb, May, Aug, Nov
exports.notifyMissedAssessments = onSchedule(
  {
    schedule: "0 0 1 * *", // runs at 00:00 UTC on the 1st of every month
    region: "europe-west2",
    timeoutSeconds: 540,
    memory: "1GiB",
    secrets: [BREVO_API_KEY],
  },
  async (event) => {
    const now = new Date();
    const currentMonth = now.getUTCMonth() + 1; // 1-12

    // Only run in Feb, May, Aug, Nov
    const validMonths = [2, 5, 8, 11];
    if (!validMonths.includes(currentMonth)) return null;

    try {
      const db = admin.firestore();

      // Get previous quarter
      const currentYear = now.getUTCFullYear();
      const currentQuarter = getCurrentQuarter();
      const { prevQuarter, prevYear } = getPreviousQuarter(
        currentQuarter,
        currentYear,
      );
      if (!prevQuarter) return null;

      // 1. Fetch all incomplete, non-onboarding assessments
      const assessmentsSnapshot = await db
        .collection("assessments")
        .where("quarter.month", "==", prevQuarter.month)
        .where("year", "==", prevYear)
        .where("is_completed", "==", false)
        .where("isOnboarding", "==", false)
        .get();

      if (assessmentsSnapshot.empty) return null;

      // 2. Collect unique users
      const userRecords = [];
      for (const doc of assessmentsSnapshot.docs) {
        const data = doc.data();
        const userRef = data.user_id;
        if (!userRef || typeof userRef.get !== "function") continue;

        const userSnap = await userRef.get();
        if (!userSnap.exists) continue;

        const userId = userSnap.id;
        if (userRecords.some((u) => u.userId === userId)) continue;

        const userData = userSnap.data() || {};
        if (!userData.email || !userData.assessment_updates) continue;

        userRecords.push({
          userId,
          email: userData.email,
          display_name: userData.display_name,
        });
      }

      if (userRecords.length === 0) return null;

      // 3. Policy check
      const year = now.getUTCFullYear();
      const month = now.getUTCMonth();
      const day = now.getUTCDate();
      const startOfDay = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
      const endOfDay = new Date(Date.UTC(year, month, day, 23, 59, 59, 999));

      const emailChunks = [];
      const allEmails = userRecords.map((u) => u.email);
      for (let i = 0; i < allEmails.length; i += 10) {
        emailChunks.push(allEmails.slice(i, i + 10));
      }

      const policies = [];
      for (const chunk of emailChunks) {
        const snap = await db
          .collection("policies")
          .where("status", "==", "Active")
          .where("user_email", "in", chunk)
          .where("starting_date", "<=", endOfDay)
          .where("ending_date", ">=", startOfDay)
          .get();

        snap.docs.forEach((doc) => {
          policies.push({ ref: doc.ref, ...doc.data() });
        });
      }

      if (policies.length === 0) return null;

      // 4. Compute locked_amount **before updating pendingAmount**
      const updatedUsers = userRecords
        .map((u) => {
          const policy = policies.find(
            (p) => p.user_email === u.email && p.pendingAmount > 0,
          );
          if (!policy) return null;
          return {
            ...u,
            locked_amount: policy.pendingAmount || 0,
            policyRef: policy.ref, // keep for batch update
          };
        })
        .filter(Boolean);

      if (updatedUsers.length === 0) return null;

      // 5. Reset pendingAmount = 0 for these policies
      const batch = db.batch();
      updatedUsers.forEach((u) => {
        batch.update(u.policyRef, { pendingAmount: 0 });
      });
      await batch.commit();

      // 6. Send emails per user
      for (const u of updatedUsers) {
        const roundedAmount = Number(u.locked_amount).toFixed(2);

        await sendEmail(
          BREVO_API_KEY.value(),
          "Your rebate expired — here's how to start again",
          `
    <html>
      <body>
        <p>Hi ${u.display_name},</p>
        <p>
          We didn't see your assessment in time, so your £${roundedAmount}
          rebate expired. Do your next assessment to unlock a new upfront
          rebate and get back on track.
        </p>
        <p>The Athlete Team</p>
        ${email_footer}
      </body>
    </html>
    `,
          "",
          [u], // ✅ correct and consistent with previous usage
        );
      }

      // 7. Build per-user notifications

      const perUserMessages = updatedUsers
        .filter((u) => u.locked_amount > 0)
        .map((u) => {
          const roundedAmount = Number(u.locked_amount).toFixed(2);

          return {
            userId: u.userId,
            title: "Oh no! You missed your assessment",
            body: `⚠️ Your £${roundedAmount} rebate expired. Do your next assessment to start again.`,
            data: {
              locked_amount: String(roundedAmount), // ✅ rounded + string
            },
          };
        });

      if (perUserMessages.length > 0) {
        await createAppNotifications(
          "Oh no! You missed your assessment",
          null,
          "assessment_updates",
          perUserMessages.map(({ userId, body }) => ({
            userId,
            message: body,
          })),
        );

        await sendPush({ perUserMessages });
      }

      return null;
    } catch (err) {
      console.error("notifyMissedAssessments failed:", err);
      return null;
    }
  },
);

// Firestore function for sending Meta "Lead", "Schedule", "Contact", "Purchase" events
// ----------------------------------------
// 1️⃣ onCreate trigger: new leads
// ----------------------------------------
exports.metaCreateNew = onDocumentCreated(
  {
    document: "leads/{leadId}",
    cors: true,
    region: "europe-west2",
    timeoutSeconds: 540,
    memory: "1GiB",
    secrets: [PIXEL_ID, ACCESS_TOKEN],
  },
  async (event) => {
    const lead = event.data?.data();

    // Only Meta leads have eventType
    if (!lead?.eventType) {
      console.log(
        `Lead ${lead?.user_email} has no eventType, skipping Meta create.`,
      );
      return;
    }

    try {
      // Always send Lead on creation
      await sendMetaEvent(
        "Lead",
        {
          email: lead.user_email,
          premiumValue: lead.premiumValue,
          fbclid: lead.meta_ids?.fbclid,
          client_user_agent: lead?.userAgent,
          client_ip_address: lead?.ipAddress,
          first_name: lead?.display_name,
          country: lead?.country,
          city: lead?.city,
        },
        PIXEL_ID.value(),
        ACCESS_TOKEN.value(),
      );

      console.log(`Meta Lead event sent for new lead: ${lead.user_email}`);
    } catch (err) {
      console.error("Failed to send Meta event for new lead:", err);
    }
  },
);

exports.metaUpdateNew = onDocumentUpdated(
  {
    document: "leads/{leadId}",
    cors: true,
    region: "europe-west2",
    timeoutSeconds: 540,
    memory: "1GiB",
    secrets: [PIXEL_ID, ACCESS_TOKEN],
  },
  async (event) => {
    const before = event.data?.before?.data() || {};
    const after = event.data?.after?.data() || {};

    // Only Meta leads have eventType
    if (!after.eventType) {
      console.log(
        `Lead ${after.user_email} has no eventType, skipping Meta update.`,
      );
      return;
    }

    // Skip repeated Lead updates
    if (after.eventType === "Lead") {
      console.log(
        `Lead ${after.user_email} already processed as Lead, skipping.`,
      );
      return;
    }

    const phoneChanged = after.phone_number !== before.phone_number;
    const premiumChanged = after.premiumValue !== before.premiumValue;
    const eventTypeChanged = after.eventType !== before.eventType;

    const shouldSendMeta = phoneChanged || premiumChanged || eventTypeChanged;

    if (!shouldSendMeta) {
      return;
    }

    try {
      await sendMetaEvent(
        after.eventType,
        {
          email: after.user_email,
          phone: after.phone_number,
          premiumValue: after.premiumValue,
          fbclid: after.meta_ids?.fbclid,
          client_user_agent: after?.userAgent,
          client_ip_address: after?.ipAddress,
          first_name: after?.display_name,
          country: after?.country,
          city: after?.city,
        },
        PIXEL_ID.value(),
        ACCESS_TOKEN.value(),
      );

      console.log(
        `Meta event "${after.eventType}" sent for updated lead: ${after.user_email}`,
      );
    } catch (err) {
      console.error(
        `Failed to send Meta event for updated lead ${after.user_email}:`,
        err,
      );
    }
  },
);

exports.getPoliciesList = onRequest(
  {
    cors: true,
    region: "europe-west2",
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async (req, res) => {
    if (req.method === "OPTIONS") return res.status(204).send("");

    const authorizationHeader = req.headers.authorization;
    if (!authorizationHeader || !authorizationHeader.startsWith("Bearer ")) {
      return res
        .status(401)
        .json({ error: "Unauthorized - Bearer token required." });
    }

    const idToken = authorizationHeader.split("Bearer ")[1];

    try {
      await admin.auth().verifyIdToken(idToken);
      const db = admin.firestore();

      const pageSize = parseInt(req.query.pageSize, 10) || 10;
      const pageToken = req.query.pageToken || null;
      const pageNumber = parseInt(req.query.pageNumber, 10) || null;
      const direction = req.query.direction || "next"; // "next" or "prev"

      const search = (req.query.search || "").trim().toLowerCase();
      const statusFilter = (req.query.status || "").trim();
      const partnerFilter = (req.query.partner || "").trim();

      // ---- Base Query: apply Firestore filterable fields (status) ----
      let baseQuery = db.collection("policies");
      if (statusFilter) {
        baseQuery = baseQuery.where("status", "==", statusFilter);
      }
      baseQuery = baseQuery.orderBy(FieldPath.documentId());

      // ---- Get all docs for filtering ----
      const allSnap = await baseQuery.get();
      const allDocs = allSnap.docs;

      // ---- Resolve users & partners, apply search + partner filter ----
      const results = [];
      for (const policyDoc of allDocs) {
        const data = policyDoc.data();

        // ---- Policy holder user ----
        // ---- Policy holder user ----
        let displayName = "N/A";
        let email = data.user_email || "N/A";
        let photo = null;

        try {
          const userSnap = await db
            .collection("users")
            .where("email", "==", data.user_email || "")
            .limit(1)
            .get();

          if (!userSnap.empty) {
            const user = userSnap.docs[0].data();
            displayName = user.display_name || displayName;
            email = user.email || email;
            photo = user.photo_url || null;
          }
        } catch (err) {
          console.error("Error fetching user:", err.message);
        }

        // ---- Search filter ----
        const searchMatch =
          !search ||
          displayName.toLowerCase().includes(search) ||
          email.toLowerCase().includes(search) ||
          String(data.monthly_price || "")
            .toLowerCase()
            .includes(search) ||
          String(data.policy_id || "")
            .toLowerCase()
            .includes(search) ||
          String(data.carrier || "")
            .toLowerCase()
            .includes(search) ||
          String(data.status || "")
            .toLowerCase()
            .includes(search);
        if (!searchMatch) continue;

        // ---- Partner filter ----
        let partnerType = "N/A";
        if (data.partner_ref) {
          try {
            const partnerSnap = await data.partner_ref.get();
            if (partnerSnap.exists) {
              const partnerData = partnerSnap.data();
              partnerType = partnerData.partner_type || "N/A";
            }
          } catch (err) {
            console.error("Error fetching partner_ref:", err.message);
          }
        }
        if (partnerFilter && partnerType !== partnerFilter) continue;

        // ---- Push final record ----
        results.push({
          id_ref: policyDoc.id,
          policy_id: data.policy_id || null,
          carrier: data.carrier || null,
          photo_url: photo,
          user_email: data.user_email,
          display_name: displayName,
          monthly_price: data.monthly_price || null,
          starting_date: data.starting_date?.toDate?.().toISOString?.() || null,
          ending_date: data.ending_date?.toDate?.().toISOString?.() || null,
          status: data.status || null,
          partner_type: partnerType,
        });
      }

      const pagination = paginate(results, {
        pageSize,
        pageToken,
        pageNumber,
        direction,
        tokenKeyExtractor: (item) => item.policy_id,
      });

      return res.status(200).json({
        policies: pagination.data,
        nextPageToken: pagination.nextPageToken,
        prevPageToken: pagination.prevPageToken,
        totalCount: pagination.totalCount,
        totalPages: pagination.totalPages,
        currentPage: pagination.currentPage,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: err.message });
    }
  },
);

exports.getUserAssessments = onRequest(async (req, res) => {
  try {
    if (req.method !== "GET") {
      return res.status(405).send("Only GET requests allowed");
    }

    const userId = req.query.userId; // e.g. ?userId=MEGKNjikBgTmkwN1JSCuUALCTLH2
    if (!userId) {
      return res.status(400).send("Missing userId parameter");
    }

    const db = admin.firestore();
    const userRef = db.collection("users").doc(userId);
    // const garmin = req.query.garmin;
    // 🔹 Query assessments where user_id is the reference
    const snapshot = await db
      .collection("cardios")
      .where("user_id", "==", userRef)
      .get();

    // const snapshot = await db
    //   .collection("users")
    //   .where("garminUserId", "==", garmin)
    //   .get();

    if (snapshot.empty) {
      return res.status(404).send("No assessments found for this user.");
    }

    // 🧾 Format data
    const assessments = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    console.log(
      `✅ Found ${assessments.length} assessments for user ${userId}`,
    );
    return res.status(200).json({ count: assessments.length, assessments });
  } catch (error) {
    console.error("❌ Error fetching assessments:", error);
    return res.status(500).send("Error fetching assessments: " + error.message);
  }
});

exports.getPolicyAvailableAmount = onRequest(
  {
    cors: true,
    region: "europe-west2",
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async (req, res) => {
    try {
      // Handle preflight CORS request
      if (req.method === "OPTIONS") {
        return res.status(204).send("");
      }

      // Firebase ID Token authentication
      const authorizationHeader = req.headers.authorization;
      if (!authorizationHeader || !authorizationHeader.startsWith("Bearer ")) {
        console.warn("Unauthorized: No Firebase ID token found.");
        return res.status(401).json({
          error: "Unauthorized",
          message: "Bearer token required.",
        });
      }

      const idToken = authorizationHeader.split("Bearer ")[1];
      try {
        await admin.auth().verifyIdToken(idToken);
      } catch (err) {
        console.warn("Unauthorized: Invalid Firebase ID token.", err);
        return res.status(401).json({
          error: "Unauthorized",
          message: "Invalid Firebase ID token.",
        });
      }

      // Validate input
      const policyId = req.query.policyId;
      if (!policyId) return res.status(400).send("Missing policyId");

      // Fetch policy document
      const doc = await admin
        .firestore()
        .collection("policies")
        .doc(policyId)
        .get();
      if (!doc.exists) return res.status(404).send("Policy not found");

      const data = doc.data();

      // Ensure availableAmount and monthly_price are doubles
      const availableAmount = Number(data.availableAmount ?? 0);

      return res.status(200).json({ availableAmount });
    } catch (error) {
      console.error("❌ Error fetching policy:", error);
      return res.status(500).send("Error fetching policy: " + error.message);
    }
  },
);

exports.assignPartnerAndCallPartnerAPI = onDocumentCreated(
  {
    document: "leads/{leadId}",
    cors: true,
    region: "europe-west2",
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async (event) => {
    const leadData = event.data?.data();
    const leadId = event.params.leadId;
    const leadRef = admin.firestore().collection("leads").doc(leadId);

    if (!leadData) {
      console.warn(`No data found for lead ${leadId}`);
      return;
    }

    try {
      // -----------------------------
      // 1️⃣ Find a Partner user dynamically
      // -----------------------------
      const partnerSnapshot = await admin
        .firestore()
        .collection("users")
        .where("role", "==", "Partner")
        .limit(1)
        .get();

      if (partnerSnapshot.empty) {
        console.warn("⚠️ No Partner found in users collection.");
        return;
      }

      const partnerDoc = partnerSnapshot.docs[0];
      const partnerRef = partnerDoc.ref;

      await leadRef.update({
        partner_type: partnerRef,
      });

      console.log(`✅ Lead ${leadId} assigned to Partner (${partnerDoc.id})`);

      // -----------------------------
      // 2️⃣ Prepare fields for Lunar CRM
      // -----------------------------
      let firstName = "";
      let surname = "";

      if (leadData.display_name) {
        const nameParts = leadData.display_name.trim().split(" ");
        firstName = nameParts[0] || "";
        surname = nameParts.slice(1).join(" ") || "";
      }

      if (!surname) surname = "Unknown";
      if (!leadData.display_name) {
        console.warn(
          `⛔ Lead ${leadId} missing display_name — skipping Lunar CRM API`,
        );
        return;
      }

      if (!firstName) {
        console.warn(
          `⛔ Lead ${leadId} missing firstName — skipping Lunar CRM API`,
        );
        return;
      }

      const apiParams = {
        MediaCampaignID: 17301,
        Amount: 1,
        App1FirstName: firstName,
        App1Surname: surname,
        App1MobileTelephone: leadData.phone_number || "",
        ProductType: "Life Insurance",
      };

      console.log(
        `📤 Calling Lunar CRM API for lead ${leadId} with params:`,
        apiParams,
      );

      // -----------------------------
      // 3️⃣ Call Lunar CRM API
      // -----------------------------
      const apiUrl =
        "https://n8n.lifeathlete.co/webhook/7f3c6e7c-72a7-43f9-a556-b0147877af17";

      const response = await axios.get(apiUrl, { params: apiParams });

      // -----------------------------
      // 4️⃣ Handle API response
      // -----------------------------
      if (
        response.data?.status === "success" &&
        response.data?.lunarMediaResponse
      ) {
        const partnerExternalId = response.data.lunarMediaResponse;

        await leadRef.update({
          partner_external_id: partnerExternalId,
        });

        console.log(
          `✅ Lead ${leadId} updated with partner_external_id: ${partnerExternalId}`,
        );
      } else {
        console.warn(
          `⚠️ API did not return lunarMediaResponse for lead ${leadId}:`,
          response.data,
        );
      }
    } catch (error) {
      console.error(`❌ Error processing lead ${leadId}:`, error);
    }
  },
);

exports.getUserRole = onRequest(
  {
    cors: true,
    region: "europe-west2",
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async (req, res) => {
    const userId = req.query.userId; // pass ?userId=abc123
    if (!userId) return res.status(400).json({ error: "Missing userId" });

    try {
      const userDoc = await admin
        .firestore()
        .collection("users")
        .doc(userId)
        .get();
      if (!userDoc.exists) {
        return res.status(404).json({ error: "User not found" });
      }

      const role = userDoc.data().role || "undefined";
      res.json({ userId, role });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

exports.getAllLeadsForCsv = onRequest(
  {
    cors: true,
    region: "europe-west2",
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async (req, res) => {
    try {
      const leadsSnap = await admin.firestore().collection("leads").get();
      if (leadsSnap.empty) {
        return res.send(JSON.stringify([])); // return empty array as string
      }

      const leadDocs = leadsSnap.docs;
      leadDocs.sort((a, b) => {
        const aData = a.data();
        const bData = b.data();

        const aDate =
          aData.modified_open?.toDate() ||
          aData.created_at?.toDate() ||
          new Date(0);
        const bDate =
          bData.modified_open?.toDate() ||
          bData.created_at?.toDate() ||
          new Date(0);

        return bDate - aDate; // descending
      });

      const leadPromises = leadDocs.map(async (leadDoc) => {
        const lead = leadDoc.data();
        const leadRef = leadDoc.ref;

        // Partner Allocated
        let partnerAllocated = null;
        try {
          if (
            lead.partner_type &&
            typeof lead.partner_type.get === "function"
          ) {
            const partnerSnap = await lead.partner_type.get();
            if (partnerSnap.exists) {
              partnerAllocated = partnerSnap.data().display_name || null;
            }
          } else if (
            lead.partner_type &&
            typeof lead.partner_type === "string"
          ) {
            const cleaned = lead.partner_type.replace(/^\/+/, "");
            const partnerSnap = await admin.firestore().doc(cleaned).get();
            if (partnerSnap.exists) {
              partnerAllocated = partnerSnap.data().display_name || null;
            }
          }
        } catch (e) {
          partnerAllocated = null;
        }

        // Policy info
        let policy = null;
        try {
          const policySnap = await admin
            .firestore()
            .collection("policies")
            .where("leads_ref", "==", leadRef)
            .limit(1)
            .get();

          if (!policySnap.empty) {
            const p = policySnap.docs[0].data();
            policy = {
              "Policy ID": p.policy_id || null,
              "Starting Date": p.starting_date
                ? p.starting_date.toDate().toISOString()
                : null,
              "Ending Date": p.ending_date
                ? p.ending_date.toDate().toISOString()
                : null,
              "Policy Status": p.status || null,
              "Monthly Premium": p.monthly_price || null,
            };
          }
        } catch (e) {
          policy = null;
        }

        // Build output object (same as before)
        const out = {
          "User's Name": lead.display_name || lead.name || null,
          "User's Email": lead.user_email || lead.email || null,
          "Phone Number": lead.phone_number || null,
          "Exercise/ Fitness Info": getExerciseFitnessInfo(lead),
          "UTM Source": lead.utm_params?.utm_source || null,
          "UTM Medium": lead.utm_params?.utm_medium || null,
          "UTM campaign": lead.utm_params?.utm_campaign || null,
          "FB- campaign id": lead.meta_ids?.campaign_id || null,
          "FB - Ad id": lead.meta_ids?.ad_id || null,
          "FB- adset id": lead.meta_ids?.adset_id || null,
          "Partner Allocated": partnerAllocated,
          Status: lead.status || null,
          "Status open": lead.modified_open
            ? lead.modified_open.toDate().toISOString()
            : null,
          "Status- call booked": lead.modified_first_call_scheduled
            ? lead.modified_first_call_scheduled.toDate().toISOString()
            : null,
          "Status - call attended": lead.modified_first_call_attended
            ? lead.modified_first_call_attended.toDate().toISOString()
            : null,
          "Gp referral": lead.modified_gp_referral
            ? lead.modified_gp_referral.toDate().toISOString()
            : null,
          Purchased: lead.modified_purchased
            ? lead.modified_purchased.toDate().toISOString()
            : null,
          Closed: lead.modified_closed
            ? lead.modified_closed.toDate().toISOString()
            : null,
          "Policy ID": policy ? policy["Policy ID"] : null,
          "Starting Date": policy ? policy["Starting Date"] : null,
          "Ending Date": policy ? policy["Ending Date"] : null,
          "Policy Status": policy ? policy["Policy Status"] : null,
          "Monthly Premium": policy ? policy["Monthly Premium"] : null,
          Flow: lead.flow || null,
          "FF financial_dependents": lead.financial_dependents || null,
          "FF life_biggest_concern": lead.life_biggest_concern || null,
          "FF income_savings": lead.income_savings || null,
          "FF critical_illness_concern": lead.critical_illness_concern || null,
          "FF existing_cover_in_place": lead.existing_cover_in_place || null,
          "FF existing_cover_what_changed":
            lead.existing_cover_what_changed || null,
        };

        return out;
      });

      const results = await Promise.all(leadPromises);

      // ✅ Convert the JSON array to a string so Bubble sees it as text
      return res.send(JSON.stringify(results));
    } catch (error) {
      console.error("getAllLeadsForCsv error:", error);
      return res.status(500).send(JSON.stringify({ error: error.message }));
    }
  },
);

// exports.garminStartNew = onRequest(
//     {cors: true, region: "europe-west2", secrets: [CLIENT_ID]},
//     async (req, res) => {
//       try {
//         console.log("garminStart called with query:", req.query);

//         const appRedirectUri = req.query.redirect_uri;
//         const userRefPath = req.query.userRef;

//         if (!appRedirectUri || !userRefPath) {
//           return res.status(400).send("Missing required parameters");
//         }

//         const userRef = admin.firestore().doc(userRefPath);

//         // --- Delete existing batches for this user ---
//         const existingBatches = await admin
//             .firestore()
//             .collection("garminSyncBatches")
//             .where("userId", "==", userRef)
//             .get();

//         const deletePromises = existingBatches.docs.map((doc) =>
//           doc.ref.delete(),
//         );
//         await Promise.all(deletePromises);
//         console.log(
//             `Deleted ${deletePromises.length} existing batch(es) for user.`,
//         );

//         // --- Generate new OAuth state ---
//         const state = generateRandomString(32);
//         const codeVerifier = generateRandomString(64);
//         const codeChallenge = generateCodeChallenge(codeVerifier);

//         // --- Create new batch ---
//         const batchRef = admin.firestore().collection("garminSyncBatches").doc();
//         await batchRef.set({
//           userId: userRef,
//           status: "processing",
//           created_at: admin.firestore.FieldValue.serverTimestamp(),
//         });

//         // --- Save OAuth state ---
//         await admin.firestore().collection("garminOauthStates").doc(state).set({
//           appRedirectUri,
//           codeVerifier,
//           batchId: batchRef.id,
//           userRefPath: userRef.path,
//           createdAt: admin.firestore.FieldValue.serverTimestamp(),
//         });

//         // --- Build Garmin auth URL ---
//         const authUrl =
//         `https://connect.garmin.com/oauth2Confirm?` +
//         `response_type=code&` +
//         `client_id=${CLIENT_ID.value()}&` +
//         `code_challenge=${codeChallenge}&` +
//         `code_challenge_method=S256&` +
//         `redirect_uri=${encodeURIComponent(
//             "https://garmincallbacknew-yoyi2vtgca-nw.a.run.app",
//         )}&` +
//         `state=${state}`;

//         console.log("Redirecting to Garmin auth URL:", authUrl);
//         res.redirect(authUrl);
//       } catch (err) {
//         console.error("Error in garminStart:", err);
//         res.status(500).send("Failed to start Garmin OAuth");
//       }
//     },
// );

// /**
//  * Step 2: Callback - exchange code for tokens
//  */
// exports.garminCallbackNew = onRequest(
//     {cors: true, region: "europe-west2", secrets: [CLIENT_ID, CLIENT_SECRET]},
//     async (req, res) => {
//       const DEFAULT_APP_REDIRECT = "athlete://athlete.com/GarminConnect";

//       try {
//         console.log("garminCallback called with query:", req.query);
//         const {code, state, error} = req.query;

//         if (!state) {
//           console.error(
//               "Missing state parameter - cleaning up failed OAuth attempts",
//           );
//           return res.redirect(
//               `${DEFAULT_APP_REDIRECT}?error=${encodeURIComponent("Invalid OAuth state")}`,
//           );
//         }

//         // Fetch PKCE state doc
//         const docRef = admin
//             .firestore()
//             .collection("garminOauthStates")
//             .doc(state);
//         const doc = await docRef.get();
//         if (!doc.exists) {
//           console.error("Invalid state - PKCE doc not found");
//           return res.redirect(
//               `${DEFAULT_APP_REDIRECT}?error=${encodeURIComponent("Invalid OAuth state")}`,
//           );
//         }

//         const {codeVerifier, appRedirectUri, batchId, userRefPath} = doc.data();
//         if (!userRefPath) {
//           console.error("userRefPath missing from PKCE state");
//           await docRef.delete();
//           return res.redirect(
//               `${DEFAULT_APP_REDIRECT}?error=${encodeURIComponent("Invalid session - Please try again")}`,
//           );
//         }

//         const userRef = admin.firestore().doc(userRefPath);

//         // Handle user denial directly
//         if (error) {
//           console.warn("Garmin OAuth error:", error);
//           await deleteAllGarminBatchesForUser({userRef});
//           await docRef.delete();
//           const friendlyError =
//           error === "access_denied" ?
//             "Access Denied - You must grant permissions to connect Garmin" :
//             `Connection Failed: ${error}`;
//           return res.redirect(
//               `${appRedirectUri}?error=${encodeURIComponent(friendlyError)}`,
//           );
//         }

//         if (!code) {
//           return res.redirect(
//               `${DEFAULT_APP_REDIRECT}?error=${encodeURIComponent("Invalid authorization code")}`,
//           );
//         }

//         // Exchange code for tokens
//         const tokenRes = await axios.post(
//             "https://diauth.garmin.com/di-oauth2-service/oauth/token",
//             new URLSearchParams({
//               grant_type: "authorization_code",
//               code,
//               redirect_uri: "https://garmincallbacknew-yoyi2vtgca-nw.a.run.app",
//               code_verifier: codeVerifier,
//             }),
//             {
//               auth: {
//                 username: CLIENT_ID.value(),
//                 password: CLIENT_SECRET.value(),
//               },
//               headers: {"Content-Type": "application/x-www-form-urlencoded"},
//             },
//         );

//         const {access_token, refresh_token, expires_in} = tokenRes.data;

//         let garminUserId = null;

//         try {
//           const res = await axios.get(
//               "https://apis.garmin.com/wellness-api/rest/user/id",
//               {headers: {Authorization: `Bearer ${access_token}`}},
//           );
//           garminUserId = res.data.userId;
//         } catch (e) {
//           console.warn("Garmin userId not ready yet");
//         }
//         const tokenExpiry = admin.firestore.Timestamp.fromDate(
//             new Date(Date.now() + expires_in * 1000),
//         );

//         // Step 2: Save user tokens and garminUserId
//         await userRef.update({
//           garminUserId: garminUserId,
//           access_token,
//           refresh_token,
//           token_expires_in: expires_in,
//           token_expiry: tokenExpiry,
//         });

//         console.log(`✅ Saved Garmin tokens and userId (${garminUserId})`);
//         await new Promise((resolve) => setTimeout(resolve, 3000)); // 2 seconds
//         // Step 3: NOW request backfill activities
//         // ✅ Check permissions with retry but do NOT delete tokens if API fails
//         let permissionsRes;
//         try {
//           permissionsRes = await axios.get(
//               "https://apis.garmin.com/wellness-api/rest/user/permissions",
//               {headers: {Authorization: `Bearer ${access_token}`}},
//           );
//         } catch (err) {
//           console.warn(
//               "Could not fetch permissions, likely Garmin delay:",
//               err.response?.data || err,
//           );
//           await deleteAllGarminBatchesForUser({userRef});
//           return res.redirect(
//               `${appRedirectUri}?batchId=${batchId || ""}&
// error=${encodeURIComponent("Permission verification pending")}`,
//           );
//         }

//         // After fetching permissions
//         const grantedPermissions = permissionsRes.data.permissions || [];
//         console.log("Final Garmin permissions:", grantedPermissions);

//         if (!grantedPermissions.includes("HISTORICAL_DATA_EXPORT")) {
//           console.warn(
//               "Missing required permission, deregistering user from Garmin",
//           );

//           // Deregister user from Garmin
//           try {
//             await axios.delete(
//                 "https://apis.garmin.com/wellness-api/rest/user/registration",
//                 {headers: {Authorization: `Bearer ${access_token}`}},
//             );
//             console.log("✅ Garmin user registration deleted");
//           } catch (err) {
//             console.warn(
//                 "⚠️ Failed to delete Garmin registration:",
//                 err.response?.data || err,
//             );
//           }

//           // Clear user tokens and garminUserId
//           await userRef.update({
//             garminUserId: admin.firestore.FieldValue.delete(),
//             access_token: admin.firestore.FieldValue.delete(),
//             refresh_token: admin.firestore.FieldValue.delete(),
//           });

//           await deleteAllGarminBatchesForUser({userRef});
//           // console.log(`appredirectURI ${appRedirectUri}`);

//           return res.redirect(
//               `${appRedirectUri}?batchId=${batchId || ""}&error=${encodeURIComponent(
//                   "Missing Historical Data Permission - Please grant all permissions",
//               )}`,
//           );
//         }
//         try {
//           const nowSec = Math.floor(Date.now() / 1000);
//           const sevenDaysAgoSec = nowSec - 7 * 24 * 60 * 60;

//           const backfillRes = await axios.get(
//               "https://apis.garmin.com/wellness-api/rest/backfill/activities",
//               {
//                 params: {
//                   userId: garminUserId,
//                   summaryStartTimeInSeconds: sevenDaysAgoSec,
//                   summaryEndTimeInSeconds: nowSec,
//                 },
//                 headers: {
//                   Authorization: `Bearer ${access_token}`,
//                 },
//               },
//           );

//           console.log("✅ Garmin backfill activities fetched:", backfillRes.data);
//         } catch (err) {
//           console.warn(
//               "⚠️ Failed to fetch Garmin backfill activities:",
//               err.response?.data || err,
//           );

//           // Check if it's a duplicate backfill error
//           if (err.response?.data?.errorMessage?.includes("duplicate backfill")) {
//             await docRef.delete();
//             await deleteAllGarminBatchesForUser({userRef});
//             return res.redirect(
//                 `${appRedirectUri}?error=${encodeURIComponent
// ("Duplicate sync detected - Please wait a few minutes before reconnecting")}`,
//             );
//           }
//         }

//         // Update batch with Garmin userId if exists
//         if (batchId) {
//           await admin
//               .firestore()
//               .collection("garminSyncBatches")
//               .doc(batchId)
//               .update({
//                 garminUserId: garminUserId || admin.firestore.FieldValue.delete(),
//               });
//           console.log(`✅ Updated batch ${batchId} with Garmin userId`);
//         }

//         // Delete PKCE state
//         await docRef.delete();

//         return res.redirect(`${appRedirectUri}?batchId=${batchId || ""}`);
//       } catch (err) {
//         console.error("Garmin OAuth failed:", err.response?.data || err);
//         return res.redirect(
//             `${DEFAULT_APP_REDIRECT}?error=${encodeURIComponent("Connection failed - Please try again")}`,
//         );
//       }
//     },
// );

exports.garminStartNew = onRequest(
  { cors: true, region: "europe-west2", secrets: [CLIENT_ID] },
  async (req, res) => {
    try {
      console.log("garminStart called with query:", req.query);

      const appRedirectUri = req.query.redirect_uri;
      const userRefPath = req.query.userRef;

      if (!appRedirectUri || !userRefPath) {
        return res.status(400).send("Missing required parameters");
      }

      const userRef = admin.firestore().doc(userRefPath);

      // Generate PKCE values
      const state = generateRandomString(32);
      const codeVerifier = generateRandomString(64);
      const codeChallenge = generateCodeChallenge(codeVerifier);

      // Save OAuth state ONLY (no batch yet)
      await admin.firestore().collection("garminOauthStates").doc(state).set({
        appRedirectUri,
        codeVerifier,
        userRefPath: userRef.path,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const authUrl =
        `https://connect.garmin.com/oauth2Confirm?` +
        `response_type=code&` +
        `client_id=${CLIENT_ID.value()}&` +
        `code_challenge=${codeChallenge}&` +
        `code_challenge_method=S256&` +
        `redirect_uri=${encodeURIComponent(
          "https://garmincallbacknew-yoyi2vtgca-nw.a.run.app",
        )}&` +
        `state=${state}`;

      console.log("Redirecting to Garmin auth URL:", authUrl);
      return res.redirect(authUrl);
    } catch (err) {
      console.error("Error in garminStart:", err);
      return res.status(500).send("Failed to start Garmin OAuth");
    }
  },
);

exports.garminCallbackNew = onRequest(
  { cors: true, region: "europe-west2", secrets: [CLIENT_ID, CLIENT_SECRET] },
  async (req, res) => {
    const DEFAULT_APP_REDIRECT = "athlete://athlete.com/GarminConnect";

    try {
      console.log("garminCallback called with query:", req.query);
      const { code, state, error } = req.query;

      if (!state) {
        return res.redirect(
          `${DEFAULT_APP_REDIRECT}?error=${encodeURIComponent("Invalid OAuth state")}`,
        );
      }

      const docRef = admin
        .firestore()
        .collection("garminOauthStates")
        .doc(state);
      const doc = await docRef.get();

      if (!doc.exists) {
        return res.redirect(
          `${DEFAULT_APP_REDIRECT}?error=${encodeURIComponent("Invalid OAuth session")}`,
        );
      }

      const { codeVerifier, appRedirectUri, userRefPath } = doc.data();
      const userRef = admin.firestore().doc(userRefPath);

      if (error) {
        await docRef.delete();
        return res.redirect(
          `${appRedirectUri}?error=${encodeURIComponent("Access Denied")}`,
        );
      }

      if (!code) {
        return res.redirect(
          `${DEFAULT_APP_REDIRECT}?error=${encodeURIComponent("Invalid authorization code")}`,
        );
      }

      // Exchange token
      const tokenRes = await axios.post(
        "https://diauth.garmin.com/di-oauth2-service/oauth/token",
        new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: "https://garmincallbacknew-yoyi2vtgca-nw.a.run.app",
          code_verifier: codeVerifier,
        }),
        {
          auth: {
            username: CLIENT_ID.value(),
            password: CLIENT_SECRET.value(),
          },
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        },
      );

      const { access_token, refresh_token, expires_in } = tokenRes.data;

      // Get Garmin user ID
      let garminUserId = null;
      try {
        const idRes = await axios.get(
          "https://apis.garmin.com/wellness-api/rest/user/id",
          { headers: { Authorization: `Bearer ${access_token}` } },
        );
        garminUserId = idRes.data.userId;
      } catch (e) {
        console.warn("Garmin userId not ready yet");
      }

      const tokenExpiry = admin.firestore.Timestamp.fromDate(
        new Date(Date.now() + expires_in * 1000),
      );

      await userRef.update({
        garminUserId,
        access_token,
        refresh_token,
        token_expiry: tokenExpiry,
      });

      await new Promise((resolve) => setTimeout(resolve, 3000)); // 2 seconds

      // Check permissions
      const permissionsRes = await axios.get(
        "https://apis.garmin.com/wellness-api/rest/user/permissions",
        { headers: { Authorization: `Bearer ${access_token}` } },
      );

      const grantedPermissions = permissionsRes.data.permissions || [];

      if (!grantedPermissions.includes("HISTORICAL_DATA_EXPORT")) {
        await userRef.update({
          garminUserId: admin.firestore.FieldValue.delete(),
          access_token: admin.firestore.FieldValue.delete(),
          refresh_token: admin.firestore.FieldValue.delete(),
        });

        await docRef.delete();

        return res.redirect(
          `${appRedirectUri}?error=${encodeURIComponent(
            "Missing Historical Data Permission",
          )}`,
        );
      }

      // 🔥 ONLY NOW create batch
      const batchRef = admin.firestore().collection("garminSyncBatches").doc();

      await batchRef.set({
        userId: userRef,
        garminUserId,
        status: "processing",
        totalActivities: 0,
        processedActivities: 0,
        created_at: admin.firestore.FieldValue.serverTimestamp(),
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Request backfill FIRST
      const nowSec = Math.floor(Date.now() / 1000);
      const sevenDaysAgoSec = nowSec - 7 * 24 * 60 * 60;

      await axios.get(
        "https://apis.garmin.com/wellness-api/rest/backfill/activities",
        {
          params: {
            userId: garminUserId,
            summaryStartTimeInSeconds: sevenDaysAgoSec,
            summaryEndTimeInSeconds: nowSec,
          },
          headers: { Authorization: `Bearer ${access_token}` },
        },
      );

      await docRef.delete();

      return res.redirect(`${appRedirectUri}?batchId=${batchRef.id}`);
    } catch (err) {
      console.error("Garmin OAuth failed:", err.response?.data || err);
      return res.redirect(
        `${DEFAULT_APP_REDIRECT}?error=${encodeURIComponent("Connection failed")}`,
      );
    }
  },
);

exports.garminWebhook = onRequest(
  { cors: true, region: "europe-west2", timeoutSeconds: 540, memory: "512MiB" },
  async (req, res) => {
    try {
      console.log("✅ Garmin webhook received");
      console.log("📦 Request body:", JSON.stringify(req.body, null, 2));

      const db = admin.firestore();
      const activityFiles = req.body.activityFiles || [];
      const userChanges = req.body.userPermissionsChange || [];

      if (!activityFiles.length) {
        console.log("ℹ️ No activity files received");

        for (const change of userChanges) {
          const garminUserId = change.userId;

          // Find user
          const userSnap = await admin
            .firestore()
            .collection("users")
            .where("garminUserId", "==", garminUserId)
            .limit(1)
            .get();

          if (userSnap.empty) {
            console.warn(`⚠️ No user found for ${garminUserId}`);
            continue;
          }

          const userRef = userSnap.docs[0].ref;
          const userData = userSnap.docs[0].data();
          const accessToken = userData.access_token;

          // Find processing batch
          const batchSnap = await admin
            .firestore()
            .collection("garminSyncBatches")
            .where("userId", "==", userRef)
            .where("status", "==", "processing")
            .limit(1)
            .get();

          if (batchSnap.empty) {
            console.warn(`⚠️ No processing batch found for ${garminUserId}`);
            continue;
          }

          const batchRef = batchSnap.docs[0].ref;
          console.log(`✅ Found batch ${batchRef.id} with no activities`);

          // Deregister from Garmin
          if (accessToken) {
            try {
              await axios.delete(
                "https://apis.garmin.com/wellness-api/rest/user/registration",
                {
                  headers: { Authorization: `Bearer ${accessToken}` },
                },
              );
              console.log(`✅ Deregistered user ${garminUserId} from Garmin`);
            } catch (err) {
              console.warn(
                "Failed to deregister from Garmin:",
                err.response?.data || err.message,
              );
            }
          }

          // Clear Garmin data from user document
          await userRef.update({
            access_token: admin.firestore.FieldValue.delete(),
            refresh_token: admin.firestore.FieldValue.delete(),
            garminUserId: admin.firestore.FieldValue.delete(),
          });

          console.log(`✅ Cleared Garmin data from user`);

          // Mark batch as error
          await batchRef.update({
            status: "error",
            processedActivities: 0,
            errorMessage:
              "No cycling or running activities found in your Garmin account",
            completedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          console.log(`✅ Batch ${batchRef.id} marked as error`);

          // Delete activities subcollection (should be empty anyway)
          const activitiesSnap = await batchRef.collection("activities").get();
          if (!activitiesSnap.empty) {
            await Promise.all(
              activitiesSnap.docs.map((doc) => doc.ref.delete()),
            );
            console.log(`🗑️ Deleted ${activitiesSnap.size} activities`);
          }
        }

        return res.status(200).json({ success: true });
      }

      // Log all incoming activity IDs and userIds
      console.log(
        "Incoming activities:",
        activityFiles.map((a) => ({
          activityId: a.activityId,
          userId: a.userId,
          activityType: a.activityType,
        })),
      );

      // Allowed activity types
      const ALLOWED_ACTIVITY_TYPES = [
        "cycling",
        "running",
        "road_biking",
        "mountain_biking",
        "virtual_ride",
        "virtual_run",
        "indoor_cycling",
        "track_running",
        "trail_running",
        "cycle",
        "bike",
        "run",
      ];

      // Group activities by Garmin user ID
      const activitiesByUser = {};
      for (const activity of activityFiles) {
        const activityType = (activity.activityType || "").toLowerCase();

        if (!ALLOWED_ACTIVITY_TYPES.includes(activityType)) {
          console.log(`⏭️ Skipping activity type: ${activityType}`);
          continue;
        }

        const garminUserId = activity.userId; // This MUST match garminUserId in Firestore
        if (!activitiesByUser[garminUserId]) {
          activitiesByUser[garminUserId] = [];
        }
        activitiesByUser[garminUserId].push(activity);
      }

      console.log(
        `👥 Processing activities for ${Object.keys(activitiesByUser).length} users`,
      );

      for (const [garminUserId, userActivities] of Object.entries(
        activitiesByUser,
      )) {
        console.log(
          `\n👤 Processing ${userActivities.length} activities for Garmin user: ${garminUserId}`,
        );

        // Find user by garminUserId
        const userSnap = await db
          .collection("users")
          .where("garminUserId", "==", garminUserId)
          .limit(1)
          .get();

        if (userSnap.empty) {
          console.log(`❌ No user found for Garmin userId: ${garminUserId}`);
          continue;
        }

        const userDoc = userSnap.docs[0];
        const user = userDoc.data();
        const userRef = userDoc.ref;

        // Ensure we have a valid access token (refresh if needed)
        const accessToken = user.access_token;
        if (!accessToken) {
          console.error(`❌ Missing access token for user ${garminUserId}`);
          continue;
        }

        // Find or create batch
        const batchSnap = await db
          .collection("garminSyncBatches")
          .where("userId", "==", userRef)
          .where("status", "==", "processing")
          .limit(1)
          .get();

        let batchRef;
        if (!batchSnap.empty) {
          batchRef = batchSnap.docs[0].ref;
          await batchRef.update({
            totalActivities: userActivities.length,
            updated_at: admin.firestore.FieldValue.serverTimestamp(),
          });
          console.log(`⚠️ Using existing batch: ${batchRef.id}`);
        } else {
          batchRef = db.collection("garminSyncBatches").doc();
          await batchRef.set({
            userId: userRef,
            garminUserId,
            status: "processing",
            totalActivities: userActivities.length,
            processedActivities: 0,
            created_at: admin.firestore.FieldValue.serverTimestamp(),
            updated_at: admin.firestore.FieldValue.serverTimestamp(),
          });
          console.log(`📦 Created new batch: ${batchRef.id}`);
        }

        let processedCount = 0;
        const hasError = false;
        const errorMessage = null;

        // Process each activity
        for (const activity of userActivities) {
          try {
            const response = await axios.get(activity.callbackURL, {
              responseType: "arraybuffer",
              headers: { Authorization: `Bearer ${user.access_token}` },
            });

            const fitBuffer = Buffer.from(response.data);
            const parsedData = await parseFitFile(fitBuffer);

            const activityDocRef = batchRef
              .collection("activities")
              .doc(String(activity.activityId));

            await activityDocRef.set({
              created_at: admin.firestore.FieldValue.serverTimestamp(),
              activityDate: parsedData.activityDate
                ? admin.firestore.Timestamp.fromDate(parsedData.activityDate)
                : null,
              userId: userRef,
              garminUserId: garminUserId,
              activityId: activity.activityId,
              activityName: activity.activityName,
              activityType: activity.activityType,
              distance: parsedData.distance || 0,
              distanceKm: parseFloat(
                ((parsedData.distance || 0) / 1000).toFixed(2),
              ),
              totalTime: parsedData.totalTime || 0,
              deviceName: activity.deviceName,
              avgPower: parsedData.avgPower || 0,
              maxPower: parsedData.maxPower || 0,
              avgHr: parsedData.avgHr || 0,
              maxHr: parsedData.maxHr || 0,
              batchId: batchRef.id,
              error: null, // Add error field
            });

            processedCount++;
            if (
              processedCount % 5 === 0 ||
              processedCount === userActivities.length
            ) {
              await batchRef.update({
                processedActivities: processedCount,
                updated_at: admin.firestore.FieldValue.serverTimestamp(), // 👈 Keep updating this
              });
            }

            console.log(
              `✅ Activity saved (${processedCount}/${userActivities.length})`,
            );
          } catch (err) {
            console.error(
              `⚠️ Failed to process activity ${activity.activityId}:`,
              err.message,
            );
            // Log the error per activity but don't break
            const errorDocRef = batchRef
              .collection("activities")
              .doc(String(activity.activityId));
            await errorDocRef.set({
              userId: userRef,
              garminUserId: garminUserId,
              activityId: activity.activityId,
              error: err.message,
              batchId: batchRef.id,
              created_at: admin.firestore.FieldValue.serverTimestamp(),
            });
          }
        }

        await batchRef.update({
          status: hasError ? "error" : "success",
          processedActivities: processedCount,
          errorMessage,
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        console.log(
          `✅ Batch ${batchRef.id} completed: ${hasError ? "error" : "success"}`,
        );
      }

      res.status(200).json({ success: true, message: "Activities processed" });
    } catch (err) {
      console.error("❌ Garmin webhook error:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  },
);

// exports.garminWebhook = onRequest(
//     {cors: true, region: "europe-west2", timeoutSeconds: 540, memory: "512MiB"},
//     async (req, res) => {
//       try {
//         console.log("✅ Garmin webhook received");
//         console.log("📦 Request body:", JSON.stringify(req.body, null, 2));

//         const db = admin.firestore();
//         const activityFiles = req.body.activityFiles || [];
//         const userChanges = req.body.userPermissionsChange || [];

//         if (!activityFiles.length) {
//           console.log("ℹ️ No activity files received");

//           for (const change of userChanges) {
//             const garminUserId = change.userId;

//             // Find user
//             const userSnap = await admin
//                 .firestore()
//                 .collection("users")
//                 .where("garminUserId", "==", garminUserId)
//                 .limit(1)
//                 .get();

//             if (userSnap.empty) {
//               console.warn(`⚠️ No user found for ${garminUserId}`);
//               continue;
//             }

//             const userRef = userSnap.docs[0].ref;
//             const userData = userSnap.docs[0].data();
//             const accessToken = userData.access_token;

//             // Find processing batch
//             const batchSnap = await admin
//                 .firestore()
//                 .collection("garminSyncBatches")
//                 .where("userId", "==", userRef)
//                 .where("status", "==", "processing")
//                 .limit(1)
//                 .get();

//             if (batchSnap.empty) {
//               console.warn(`⚠️ No processing batch found for ${garminUserId}`);
//               continue;
//             }

//             const batchRef = batchSnap.docs[0].ref;
//             console.log(`✅ Found batch ${batchRef.id} with no activities`);

//             // Deregister from Garmin
//             if (accessToken) {
//               try {
//                 await axios.delete(
//                     "https://apis.garmin.com/wellness-api/rest/user/registration",
//                     {
//                       headers: {Authorization: `Bearer ${accessToken}`},
//                     },
//                 );
//                 console.log(`✅ Deregistered user ${garminUserId} from Garmin`);
//               } catch (err) {
//                 console.warn(
//                     "Failed to deregister from Garmin:",
//                     err.response?.data || err.message,
//                 );
//               }
//             }

//             // Clear Garmin data from user document
//             await userRef.update({
//               access_token: admin.firestore.FieldValue.delete(),
//               refresh_token: admin.firestore.FieldValue.delete(),
//               garminUserId: admin.firestore.FieldValue.delete(),
//             });

//             console.log(`✅ Cleared Garmin data from user`);

//             // Mark batch as error
//             await batchRef.update({
//               status: "error",
//               processedActivities: 0,
//               errorMessage:
//               "No cycling or running activities found in your Garmin account",
//               completedAt: admin.firestore.FieldValue.serverTimestamp(),
//             });

//             console.log(`✅ Batch ${batchRef.id} marked as error`);

//             // Delete activities subcollection (should be empty anyway)
//             const activitiesSnap = await batchRef.collection("activities").get();
//             if (!activitiesSnap.empty) {
//               await Promise.all(
//                   activitiesSnap.docs.map((doc) => doc.ref.delete()),
//               );
//               console.log(`🗑️ Deleted ${activitiesSnap.size} activities`);
//             }
//           }

//           return res.status(200).json({success: true});
//         }

//         // Log all incoming activity IDs and userIds
//         console.log(
//             "Incoming activities:",
//             activityFiles.map((a) => ({
//               activityId: a.activityId,
//               userId: a.userId,
//               activityType: a.activityType,
//             })),
//         );

//         // Allowed activity types
//         const ALLOWED_ACTIVITY_TYPES = [
//           "cycling",
//           "running",
//           "road_biking",
//           "mountain_biking",
//           "virtual_ride",
//           "virtual_run",
//           "indoor_cycling",
//           "track_running",
//           "trail_running",
//           "cycle",
//           "bike",
//           "run",
//         ];

//         // Group activities by Garmin user ID
//         const activitiesByUser = {};
//         for (const activity of activityFiles) {
//           const activityType = (activity.activityType || "").toLowerCase();

//           if (!ALLOWED_ACTIVITY_TYPES.includes(activityType)) {
//             console.log(`⏭️ Skipping activity type: ${activityType}`);
//             continue;
//           }

//           const garminUserId = activity.userId; // This MUST match garminUserId in Firestore
//           if (!activitiesByUser[garminUserId]) {
//             activitiesByUser[garminUserId] = [];
//           }
//           activitiesByUser[garminUserId].push(activity);
//         }

//         console.log(
//             `👥 Processing activities for ${Object.keys(activitiesByUser).length} users`,
//         );

//         for (const [garminUserId, userActivities] of Object.entries(
//             activitiesByUser,
//         )) {
//           console.log(
//               `\n👤 Processing ${userActivities.length} activities for Garmin user: ${garminUserId}`,
//           );

//           // Find user by garminUserId
//           const userSnap = await db
//               .collection("users")
//               .where("garminUserId", "==", garminUserId)
//               .limit(1)
//               .get();

//           if (userSnap.empty) {
//             console.log(`❌ No user found for Garmin userId: ${garminUserId}`);
//             continue;
//           }

//           const userDoc = userSnap.docs[0];
//           const user = userDoc.data();
//           const userRef = userDoc.ref;

//           // Ensure we have a valid access token (refresh if needed)
//           const accessToken = user.access_token;
//           if (!accessToken) {
//             console.error(`❌ Missing access token for user ${garminUserId}`);
//             continue;
//           }

//           // Find or create batch
//           const batchSnap = await db
//               .collection("garminSyncBatches")
//               .where("userId", "==", userRef)
//               .where("status", "==", "processing")
//               .limit(1)
//               .get();

//           let batchRef;
//           if (!batchSnap.empty) {
//             batchRef = batchSnap.docs[0].ref;
//             await batchRef.update({
//               totalActivities: userActivities.length,
//               updated_at: admin.firestore.FieldValue.serverTimestamp(),
//             });
//             console.log(`⚠️ Using existing batch: ${batchRef.id}`);
//           } else {
//             batchRef = db.collection("garminSyncBatches").doc();
//             await batchRef.set({
//               userId: userRef,
//               garminUserId,
//               status: "processing",
//               totalActivities: userActivities.length,
//               processedActivities: 0,
//               created_at: admin.firestore.FieldValue.serverTimestamp(),
//               updated_at: admin.firestore.FieldValue.serverTimestamp(),
//             });
//             console.log(`📦 Created new batch: ${batchRef.id}`);
//           }

//           let processedCount = 0;
//           const hasError = false;
//           const errorMessage = null;

//           // Process each activity
//           for (const activity of userActivities) {
//             try {
//               const response = await axios.get(activity.callbackURL, {
//                 responseType: "arraybuffer",
//                 headers: {Authorization: `Bearer ${user.access_token}`},
//               });

//               const fitBuffer = Buffer.from(response.data);
//               const parsedData = await parseFitFile(fitBuffer);

//               const activityDocRef = batchRef
//                   .collection("activities")
//                   .doc(String(activity.activityId));

//               await activityDocRef.set({
//                 created_at: admin.firestore.FieldValue.serverTimestamp(),
//                 activityDate: parsedData.activityDate ?
//                 admin.firestore.Timestamp.fromDate(parsedData.activityDate) :
//                 null,
//                 userId: userRef,
//                 garminUserId: garminUserId,
//                 activityId: activity.activityId,
//                 activityName: activity.activityName,
//                 activityType: activity.activityType,
//                 distance: parsedData.distance || 0,
//                 distanceKm: parseFloat(
//                     ((parsedData.distance || 0) / 1000).toFixed(2),
//                 ),
//                 totalTime: parsedData.totalTime || 0,
//                 deviceName: activity.deviceName,
//                 avgPower: parsedData.avgPower || 0,
//                 maxPower: parsedData.maxPower || 0,
//                 avgHr: parsedData.avgHr || 0,
//                 maxHr: parsedData.maxHr || 0,
//                 batchId: batchRef.id,
//                 error: null, // Add error field
//               });

//               processedCount++;
//               if (
//                 processedCount % 5 === 0 ||
//               processedCount === userActivities.length
//               ) {
//                 await batchRef.update({
//                   processedActivities: processedCount,
//                   updated_at: admin.firestore.FieldValue.serverTimestamp(), // 👈 Keep updating this
//                 });
//               }

//               console.log(
//                   `✅ Activity saved (${processedCount}/${userActivities.length})`,
//               );
//             } catch (err) {
//               console.error(
//                   `⚠️ Failed to process activity ${activity.activityId}:`,
//                   err.message,
//               );
//               // Log the error per activity but don't break
//               const errorDocRef = batchRef
//                   .collection("activities")
//                   .doc(String(activity.activityId));
//               await errorDocRef.set({
//                 userId: userRef,
//                 garminUserId: garminUserId,
//                 activityId: activity.activityId,
//                 error: err.message,
//                 batchId: batchRef.id,
//                 created_at: admin.firestore.FieldValue.serverTimestamp(),
//               });
//             }
//           }

//           await batchRef.update({
//             status: hasError ? "error" : "success",
//             processedActivities: processedCount,
//             errorMessage,
//             completedAt: admin.firestore.FieldValue.serverTimestamp(),
//           });

//           console.log(
//               `✅ Batch ${batchRef.id} completed: ${hasError ? "error" : "success"}`,
//           );
//         }

//         res.status(200).json({success: true, message: "Activities processed"});
//       } catch (err) {
//         console.error("❌ Garmin webhook error:", err);
//         res.status(500).json({success: false, error: err.message});
//       }
//     },
// );

exports.garminUserUpdate = onRequest(
  { cors: true, region: "europe-west2", timeoutSeconds: 300, memory: "256MiB" },
  async (req, res) => {
    try {
      console.log("✅ Garmin user update webhook received");
      console.log("📦 Request body:", JSON.stringify(req.body, null, 2));

      const db = admin.firestore();
      const userChanges = req.body.userPermissionsChange || [];
      const deregistrations = req.body.userDeregistrations || [];

      // Handle user permission changes
      if (userChanges.length) {
        console.log(`ℹ️ Processing ${userChanges.length} permission changes`);
        for (const change of userChanges) {
          const garminUserId = change.userId;
          const permissions = change.permissions || [];

          // Find Firestore user by garminUserId
          const userSnap = await db
            .collection("users")
            .where("garminUserId", "==", garminUserId)
            .limit(1)
            .get();

          if (userSnap.empty) {
            console.warn(`⚠️ No user found for Garmin userId: ${garminUserId}`);
            continue;
          }

          const userRef = userSnap.docs[0].ref;

          // Update user document with new permissions
          await userRef.update({
            grantedGarminPermissions: permissions,
            lastGarminPermissionsChange:
              admin.firestore.FieldValue.serverTimestamp(),
          });

          console.log(
            `✅ Updated permissions for user ${garminUserId}:`,
            permissions,
          );
        }
      }

      // Handle user deregistrations
      if (deregistrations.length) {
        console.log(`ℹ️ Processing ${deregistrations.length} deregistrations`);
        for (const dereg of deregistrations) {
          const garminUserId = dereg.userId;

          // Find Firestore user
          const userSnap = await db
            .collection("users")
            .where("garminUserId", "==", garminUserId)
            .limit(1)
            .get();

          if (userSnap.empty) {
            console.warn(`⚠️ No user found for Garmin userId: ${garminUserId}`);
            continue;
          }

          const userRef = userSnap.docs[0].ref;

          // Delete all batches & activities
          const batchSnap = await db
            .collection("garminSyncBatches")
            .where("userId", "==", userRef)
            .get();

          for (const batchDoc of batchSnap.docs) {
            const batchRef = batchDoc.ref;
            const activitiesSnap = await batchRef
              .collection("activities")
              .get();

            await Promise.all(
              activitiesSnap.docs.map((doc) => doc.ref.delete()),
            );

            await batchRef.delete();
            console.log(`🗑️ Deleted batch ${batchRef.id} and its activities`);
          }

          // Remove Garmin connection from user
          await userRef.update({
            garminUserId: admin.firestore.FieldValue.delete(),
            access_token: admin.firestore.FieldValue.delete(),
            refresh_token: admin.firestore.FieldValue.delete(),
            grantedGarminPermissions: admin.firestore.FieldValue.delete(),
          });

          console.log(`❌ User ${garminUserId} deregistered and cleaned up`);
        }
      }

      res
        .status(200)
        .json({ success: true, message: "User updates processed" });
    } catch (err) {
      console.error("❌ Error processing Garmin user update:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  },
);

// ---------------------- Get Garmin Tokens by Session ----------------------
exports.getGarminTokens = onRequest(
  { cors: true, region: "europe-west2" },
  async (req, res) => {
    try {
      const { sessionId } = req.query;

      if (!sessionId) {
        return res.status(400).send("Missing sessionId");
      }

      const ref = admin
        .firestore()
        .collection("garminOauthSessions")
        .doc(sessionId);

      const doc = await ref.get();
      if (!doc.exists) {
        return res.status(404).send("Session expired or not found");
      }

      const data = doc.data();

      // Delete session after reading
      try {
        await ref.delete();
        console.log("Session deleted:", sessionId);
      } catch (err) {
        console.warn("Failed to delete session:", err);
      }

      res.json({
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        expiresIn: data.expiresIn,
      });
    } catch (err) {
      console.error("Failed to get Garmin tokens:", err);
      res.status(500).send("Failed to get Garmin tokens");
    }
  },
);

/**
 * Scheduled function to clean up stale processing batches
 * Runs every 1 minute
 */
exports.cleanupStaleBatches = onSchedule(
  {
    schedule: "*/1 * * * *",
    region: "europe-west2",
    timeoutSeconds: 540,
  },
  async (event) => {
    try {
      console.log("🧹 Starting cleanup of stale batches");

      const db = admin.firestore();
      const now = admin.firestore.Timestamp.now();

      const ninetySecondsAgo = admin.firestore.Timestamp.fromMillis(
        now.toMillis() - 30 * 1000,
      );

      const staleBatches = await db
        .collection("garminSyncBatches")
        .where("status", "==", "processing")
        .where("created_at", "<=", ninetySecondsAgo)
        .get();

      if (staleBatches.empty) {
        console.log("ℹ️ No stale batches found");
        return;
      }

      console.log(`Found ${staleBatches.size} stale batches to check`);

      for (const batchDoc of staleBatches.docs) {
        const batchRef = batchDoc.ref;
        const batchData = batchDoc.data();

        console.log(`🔍 Checking batch: ${batchRef.id}`);

        try {
          const activitiesSnap = await batchRef.collection("activities").get();

          const updatedAt =
            batchData.updated_at?.toMillis() ||
            batchData.created_at?.toMillis();
          const thirtySecondsAgo = now.toMillis() - 30 * 1000;
          const isRecentlyUpdated = updatedAt && updatedAt > thirtySecondsAgo;

          if (isRecentlyUpdated) {
            console.log(
              `⏳ Batch ${batchRef.id} was updated recently, still processing...`,
            );
            continue;
          }

          if (activitiesSnap.empty) {
            console.log(
              `❌ No activities in batch ${batchRef.id}, deregistering user`,
            );

            // Get user reference
            const userId = batchData.userId;

            if (userId) {
              try {
                const userDoc = await userId.get();

                if (userDoc.exists) {
                  const userData = userDoc.data();
                  const accessToken = userData.access_token;

                  // Deregister from Garmin
                  if (accessToken) {
                    try {
                      await axios.delete(
                        "https://apis.garmin.com/wellness-api/rest/user/registration",
                        {
                          headers: { Authorization: `Bearer ${accessToken}` },
                        },
                      );
                      console.log(
                        `✅ Deregistered user from Garmin for batch ${batchRef.id}`,
                      );
                    } catch (err) {
                      console.warn(
                        `Failed to deregister from Garmin for batch ${batchRef.id}:`,
                        err.response?.data || err.message,
                      );
                      // Continue even if deregistration fails
                    }
                  }

                  // Clear Garmin tokens from user document
                  await userId.update({
                    access_token: admin.firestore.FieldValue.delete(),
                    refresh_token: admin.firestore.FieldValue.delete(),
                    garminUserId: admin.firestore.FieldValue.delete(),
                  });

                  console.log(
                    `✅ Cleared Garmin data from user for batch ${batchRef.id}`,
                  );
                }
              } catch (err) {
                console.error(
                  `Failed to deregister user for batch ${batchRef.id}:`,
                  err,
                );
                // Continue to mark batch as error even if user cleanup fails
              }
            }

            // ALWAYS mark batch as error - this should happen regardless of user cleanup success
            try {
              await batchRef.update({
                status: "error",
                processedActivities: 0,
                errorMessage:
                  "No cycling or running activities found in your Garmin account",
                completedAt: admin.firestore.FieldValue.serverTimestamp(),
              });
              console.log(`✅ Marked batch ${batchRef.id} as error`);
            } catch (updateErr) {
              console.error(
                `❌ Failed to update batch ${batchRef.id}:`,
                updateErr,
              );
            }
          } else {
            const processedCount = activitiesSnap.size;
            const expectedCount = batchData.totalActivities || processedCount;

            console.log(
              `📊 Batch ${batchRef.id}: ${processedCount}/${expectedCount} activities`,
            );

            try {
              if (
                processedCount >= expectedCount ||
                !batchData.totalActivities
              ) {
                console.log(`✅ Marking batch ${batchRef.id} as success`);

                await batchRef.update({
                  status: "success",
                  processedActivities: processedCount,
                  errorMessage: null,
                  completedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
              } else {
                console.log(
                  `⚠️ Marking batch ${batchRef.id} as partial success`,
                );

                await batchRef.update({
                  status: "success",
                  processedActivities: processedCount,
                  errorMessage: `Processed ${processedCount} of ${expectedCount} activities`,
                  completedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
              }
              console.log(`✅ Updated batch ${batchRef.id} status`);
            } catch (updateErr) {
              console.error(
                `❌ Failed to update batch ${batchRef.id}:`,
                updateErr,
              );
            }
          }
        } catch (batchErr) {
          console.error(`❌ Error processing batch ${batchRef.id}:`, batchErr);
          // Try to mark batch as error anyway
          try {
            await batchRef.update({
              status: "error",
              processedActivities: 0,
              errorMessage: "Error during cleanup processing",
              completedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            console.log(
              `✅ Marked batch ${batchRef.id} as error after exception`,
            );
          } catch (fallbackErr) {
            console.error(
              `❌ Failed to mark batch ${batchRef.id} as error:`,
              fallbackErr,
            );
          }
        }
      }

      console.log("✅ Stale batch cleanup completed");
    } catch (err) {
      console.error("❌ Error cleaning up stale batches:", err);
    }
  },
);

// exports.getRunsByCardiosAndAssessment = onRequest(async (req, res) => {
//   try {
//     if (req.method !== "GET") {
//       return res.status(405).send("Only GET requests allowed");
//     }

//     const {
//       currentCardioId,
//       prevCardioId,
//       currentAssessmentId,
//       prevAssessmentId,
//     } = req.query;

//     if (!currentCardioId || !currentAssessmentId) {
//       return res
//           .status(400)
//           .send("Missing currentCardioId or currentAssessmentId");
//     }

//     const db = admin.firestore();

//     // Assessment references
//     const currentRef = db.collection("assessments").doc(currentAssessmentId);
//     const assessmentRefs = [currentRef];
//     if (prevAssessmentId) {
//       const prevRef = db.collection("assessments").doc(prevAssessmentId);
//       assessmentRefs.push(prevRef);
//     }

//     // Cardio IDs to query
//     const cardioIds = [currentCardioId];
//     if (prevCardioId) cardioIds.push(prevCardioId);

//     let allRuns = [];

//     for (const cardioId of cardioIds) {
//       const runsSnap = await db
//           .collection("cardios")
//           .doc(cardioId)
//           .collection("runs")
//           .get();

//       console.log(`Cardio ${cardioId} has ${runsSnap.size} runs`);

//       runsSnap.docs.forEach((doc) => {
//         const data = doc.data();
//         console.log(
//             `Processing run: ${doc.id}, assessment_ref:`,
//             data.assessment_ref?.id || data.assessment_ref,
//         );

//         if (!data.assessment_ref) return; // skip runs without assessment_ref

//         if (assessmentRefs.some((ref) => ref.isEqual(data.assessment_ref))) {
//           console.log(`✅ Run matched: ${doc.id}`);
//           allRuns.push({
//             runId: doc.id,
//             cardioId: cardioId,
//             assessmentId: data.assessment_ref.id,
//             pace: data.pace || null,
//             distance: data.distance || null,
//             speed: data.speed || null,
//             time: data.time || null,
//             user_ref: data.user_ref.id,
//             created_at: data.created_at.toDate().toISOString(),
//           });
//         }
//       });
//     }

//     // Sort by pace increasing
//     allRuns = allRuns
//         .filter((r) => r.pace !== null)
//         .sort((a, b) => a.pace - b.pace);

//     return res.status(200).json({
//       totalFetched: allRuns.length, // use allRuns, not runsSnap
//       runs: allRuns,
//     });
//   } catch (err) {
//     console.error("❌ Error fetching runs:", err);
//     return res.status(500).send(err.message);
//   }
// });

// exports.reAddRunsFromJson = onRequest(
//     {
//       region: "europe-west2",
//       timeoutSeconds: 540,
//       memory: "1GiB",
//     },
//     async (req, res) => {
//       try {
//         if (req.method !== "POST") {
//           return res.status(405).send("POST only");
//         }

//         const runs = req.body;

//         if (!Array.isArray(runs) || runs.length === 0) {
//           return res.status(400).json({
//             error: "Request body must be a non-empty array of runs",
//           });
//         }

//         const db = admin.firestore();

//         let batch = db.batch();
//         let batchCount = 0;
//         let created = 0;
//         let skipped = 0;

//         for (const run of runs) {
//           const {
//             cardioId,
//             assessmentId,
//             user_ref,
//             pace,
//             distance,
//             time,
//             speed,
//             created_at,
//           } = run;

//           // 🔒 HARD validation
//           if (!cardioId || !assessmentId || !user_ref || !created_at) {
//             skipped++;
//             continue;
//           }

//           const runRef = db
//               .collection("cardios")
//               .doc(cardioId)
//               .collection("runs")
//               .doc(); // new ID per JSON entry

//           batch.set(runRef, {
//             pace: pace ?? null,
//             distance: distance ?? null,
//             time: time ?? null,
//             speed: speed ?? null,

//             user_ref: db.doc(`users/${user_ref}`),
//             assessment_ref: db.doc(`assessments/${assessmentId}`),
//             cardio_id: db.doc(`cardios/${cardioId}`),

//             created_at: Timestamp.fromDate(new Date(run.created_at)),
//           });

//           created++;
//           batchCount++;

//           // Firestore batch safety
//           if (batchCount >= 450) {
//             await batch.commit();
//             batch = db.batch();
//             batchCount = 0;
//           }
//         }

//         if (batchCount > 0) {
//           await batch.commit();
//         }

//         return res.status(200).json({
//           message: "Runs re-added successfully",
//           created,
//           skipped,
//           total: runs.length,
//         });
//       } catch (error) {
//         console.error("❌ Error re-adding runs:", error);
//         return res.status(500).json({
//           error: error.message,
//         });
//       }
//     },
// );

// exports.recalculateCardioPreview = onRequest(async (req, res) => {
//   try {
//     // Only GET requests
//     if (req.method !== "GET") {
//       return res.status(405).send("Only GET requests allowed");
//     }

//     const db = admin.firestore();

//     // Old cardio document
//     const oldCardioDocId = "nQbCYa79bF5hCyKrsNVb";
//     const cardioRef = db.collection("cardios").doc(oldCardioDocId);
//     const cardioSnap = await cardioRef.get();

//     if (!cardioSnap.exists) {
//       return res.status(404).send("Old cardio document not found.");
//     }

//     const cardioData = cardioSnap.data();

//     // Fetch all runs
//     const runsSnap = await cardioRef.collection("runs").get();
//     const runs = runsSnap.docs.map((doc) => doc.data());

//     // Fetch all cycling
//     const cyclingSnap = await cardioRef.collection("cycling").get();
//     const cycling = cyclingSnap.docs.map((doc) => doc.data());

//     // --- Helper: Process a run activity ---
//     const processRun = (run) => {
//       const distanceKm = run.distance; // already in km
//       const timeMin = run.time; // already in min
//       const pace = distanceKm > 0 ? timeMin / distanceKm : 0;
//       const speed = distanceKm / (timeMin / 60);
//       const velocity = (distanceKm * 1000) / timeMin;
//       const numerator =
//         -4.6 + 0.182258 * velocity + 0.000104 * velocity * velocity;
//       const denominator =
//         (0.8 +
//           0.1894393 * Math.exp(-0.012778 * timeMin) +
//           0.2989558 * Math.exp(-0.1932605 * timeMin)) *
//         100;
//       const vo2max = denominator !== 0 ? (numerator / denominator) * 100 : 0;
//       return { distanceKm, timeMin, pace, speed, vo2max };
//     };

//     // --- Calculate run aggregates ---
//     let totalDistance = 0;
//     let totalTime = 0;
//     let fastestPace = null;
//     let fastestRun = null;

//     runs.forEach((run) => {
//       const r = processRun(run);
//       totalDistance += r.distanceKm;
//       totalTime += r.timeMin;

//       if (!fastestPace || r.pace < fastestPace) {
//         fastestPace = r.pace;
//         fastestRun = r;
//         fastestRun.distance = r.distanceKm;
//         fastestRun.time = r.timeMin;
//         fastestRun.pace = r.pace;
//       }
//     });

//     const avgDistance = runs.length > 0 ? totalDistance / runs.length : 0;
//     const avgTime = runs.length > 0 ? totalTime / runs.length : 0;
//     const avgPace = avgDistance > 0 ? avgTime / avgDistance : 0;
//     const avgSpeed = avgTime > 0 ? avgDistance / (avgTime / 60) : 0;

//     // --- VO2max from fastest run ---
//     const vo2maxRun = fastestRun ? fastestRun.vo2max : null;

//     // --- Helper: Calculate Cardio Level ---
//     function findCardioLevel({ predicted5kTimeMin, gender, dob, distance5k }) {
//       const now = new Date();
//       let age = now.getFullYear() - dob.getFullYear();
//       if (
//         now.getMonth() < dob.getMonth() ||
//         (now.getMonth() === dob.getMonth() && now.getDate() < dob.getDate())
//       ) {
//         age--;
//       }

//       const maleThresholds = {
//         "18-29": [
//           [37.1, 32.5],
//           [32.4, 28.9],
//           [28.8, 26.0],
//           [25.9, 23.6],
//           [23.5, 21.7],
//           [21.6, 20.0],
//           [19.9, 17.3],
//           [17.2, 15.3],
//           [15.2, 13.7],
//           [13.6, 13.0],
//         ],
//         "30-39": [
//           [37.9, 33.2],
//           [33.1, 29.5],
//           [29.4, 26.5],
//           [26.4, 24.1],
//           [24.0, 22.1],
//           [22.0, 20.4],
//           [20.3, 17.7],
//           [17.6, 15.6],
//           [15.5, 14.0],
//           [13.9, 13.3],
//         ],
//         "40-49": [
//           [40.4, 35.3],
//           [35.2, 31.4],
//           [31.3, 28.3],
//           [28.2, 25.7],
//           [25.5, 23.6],
//           [23.5, 21.7],
//           [21.6, 18.8],
//           [18.7, 16.6],
//           [16.5, 14.9],
//           [14.8, 14.1],
//         ],
//         "50-59": [
//           [42.7, 37.4],
//           [37.2, 33.2],
//           [33.1, 29.9],
//           [29.8, 27.2],
//           [27.0, 24.9],
//           [24.8, 23.0],
//           [22.9, 19.9],
//           [19.8, 17.6],
//           [17.5, 15.7],
//           [15.6, 14.9],
//         ],
//         "60-69": [
//           [46.4, 40.6],
//           [40.5, 36.1],
//           [36.0, 32.5],
//           [32.4, 29.5],
//           [29.4, 27.1],
//           [27.0, 25.0],
//           [24.9, 21.7],
//           [21.5, 19.1],
//           [19.0, 17.1],
//           [17.0, 16.3],
//         ],
//         "70+": [
//           [51.6, 45.1],
//           [45.0, 40.1],
//           [40.0, 36.1],
//           [36.0, 32.8],
//           [32.6, 30.1],
//           [30.0, 27.8],
//           [27.6, 24.1],
//           [23.9, 21.2],
//           [21.1, 19.0],
//           [18.9, 18.1],
//         ],
//       };
//       const table =
//         gender.toLowerCase() === "male" ? maleThresholds : maleThresholds; // only male for now
//       const bracket = "40-49";
//       const levels = table[bracket];

//       const fastest = predicted5kTimeMin * Math.pow(5 / distance5k, 1.07);
//       if (fastest > levels[0][0]) return 1;
//       if (fastest <= levels[levels.length - 1][1]) return 10;

//       for (let i = 0; i < levels.length; i++) {
//         const [max, min] = levels[i];
//         if (fastest <= max && fastest > min) return i + 1;
//       }
//       return 10;
//     }

//     // --- Compute new cardio level ---
//     const newCardioLevel = findCardioLevel({
//       predicted5kTimeMin: fastestRun
//         ? fastestRun.pace * fastestRun.distance
//         : 0,
//       distance5k: fastestRun ? fastestRun.distance : 0,
//       gender: "male",
//       dob: new Date("1982-05-11T04:00:00Z"),
//     });

//     // --- Prepare recalculated preview ---
//     const recalculatedPreview = {
//       user_id: cardioData.user_id,
//       platform: cardioData.platform,
//       runCount: runs.length,
//       average_distance: avgDistance,
//       average_time: avgTime,
//       average_pace: avgPace,
//       average_speed: avgSpeed,
//       fastest_run_distance: fastestRun ? fastestRun.distance : 0,
//       fastest_run_time: fastestRun ? fastestRun.time : 0,
//       fastest_predicted_5k: fastestRun ? fastestRun.pace : 0,
//       time_5k: fastestRun ? fastestRun.time : 0,
//       vo2max: vo2maxRun,
//       recalculated_level: newCardioLevel,
//     };

//     console.log("🔥 Recalculated Preview:", recalculatedPreview);

//     return res.status(200).json(recalculatedPreview);
//   } catch (error) {
//     console.error("❌ Error recalculating cardio preview:", error);
//     return res.status(500).send("Error: " + error.message);
//   }
// });
