(function (root) {
  "use strict";

  var labels = {
    "TV Show": "مسلسل", "TV series": "مسلسل", "TV Series": "مسلسل",
    "Viewing History": "سجل المشاهدة", "All Viewing History": "سجل المشاهدة الكامل",
    "No Viewing History Yet": "لا يوجد سجل مشاهدة بعد", "No viewing history yet.": "لا يوجد سجل مشاهدة بعد.",
    "Titles you watch will appear here with your playback progress.": "ستظهر هنا العناوين التي تشاهدها وموضع توقفك.",
    "Watch Home": "صفحة المشاهدة الرئيسية", "Watch Settings": "إعدادات المشاهدة",
    "Search results": "نتائج البحث", "Search filters": "عوامل تصفية البحث",
    "Show details": "التفاصيل", "Title information": "معلومات العنوان",
    "Featured cast": "طاقم العمل", "Created by": "ابتكار", "Directed by": "إخراج",
    "Genres": "الأنواع", "Original network": "القناة الأصلية", "Studios": "الاستوديوهات",
    "Status": "الحالة", "Original language": "اللغة الأصلية",
    "No season metadata available. Return to Details and retry.": "معلومات المواسم غير متاحة. ارجع إلى التفاصيل وأعد المحاولة.",
    "Loading season metadata…": "جارٍ تحميل المواسم…",
    "Loading details…": "جارٍ تحميل التفاصيل…", "No titles found.": "لم يتم العثور على عناوين.",
    "More details unavailable; search result information remains visible.": "المزيد من التفاصيل غير متاح.",
    "No aired episodes returned for this season.": "لا توجد حلقات متاحة لهذا الموسم.",
    "Open in LG YouTube App": "فتح في تطبيق يوتيوب",
    "Rewind": "رجوع", "Forward": "تقديم", "target": "الموضع", "OK to confirm": "اضغط موافق للتأكيد",
    "OK seeks": "اضغط موافق للانتقال",
    "Ready to start": "جاهز للبدء",
    "Nothing in Continue Watching yet.": "لا توجد عناوين لمتابعتها بعد.",
    "Continue watching": "متابعة المشاهدة", "Continue Watching · resume or choose the next confirmed episode": "متابعة المشاهدة · استأنف أو اختر الحلقة التالية",
    "Play now": "شاهد الآن", "Watch Now": "شاهد الآن",
    "Watch": "المشاهدة", "Home": "الرئيسية", "For You": "لك", "Top Picks for You": "مختارات لك",
    "TV": "مسلسل", "TV Shows": "المسلسلات", "Movies": "الأفلام", "Movie": "فيلم", "Discover": "اكتشف",
    "Cast": "بث إلى التلفاز", "Cast & Crew": "طاقم العمل", "Search": "بحث", "Search titles": "ابحث عن عنوان",
    "History": "السجل", "Watch History": "سجل المشاهدة", "History Overview": "نظرة عامة على السجل",
    "← History Overview": "← نظرة عامة على السجل", "Recently Watched": "شوهد مؤخرًا",
    "Continue Watching": "متابعة المشاهدة", "View All Media": "عرض كل العناوين",
    "Explore Watch Home": "استكشف الصفحة الرئيسية", "Clear History": "مسح السجل",
    "Confirm clear history": "تأكيد مسح السجل", "All": "الكل", "Details": "التفاصيل",
    "← Details": "← التفاصيل", "← Results": "← النتائج", "Back to results": "رجوع إلى النتائج",
    "Back": "رجوع", "← Back": "← رجوع", "Back to Horizon": "رجوع", "Exit to Watch": "خروج من المشغل",
    "Filter history titles…": "تصفية عناوين السجل…", "Filter history titles": "تصفية عناوين السجل",
    "No matching titles found in your viewing history.": "لا توجد عناوين مطابقة في سجل المشاهدة.",
    "Recommendations": "التوصيات", "Show More": "عرض المزيد", "Load More": "تحميل المزيد",
    "Back to list": "رجوع إلى القائمة", "Remove from History": "إزالة من السجل",
    "Confirm remove from history": "تأكيد الإزالة من السجل",
    "Restore to Continue": "استعادة إلى متابعة المشاهدة", "Hide from Continue": "إخفاء من متابعة المشاهدة",
    "No unfinished titles saved.": "لا توجد عناوين غير مكتملة.",
    "No saved viewing history.": "لا يوجد سجل مشاهدة محفوظ.",
    "Reset recommendation choices": "إعادة ضبط اختيارات التوصيات", "Confirm reset choices": "تأكيد إعادة الضبط",
    "Appearance & Motion": "المظهر والحركة", "Browsing & Display": "التصفح والعرض",
    "Library & Content": "المكتبة والمحتوى", "About Horizon": "نبذة عن هورايزن",
    "Navigation & Motion": "التنقل والحركة", "Hero & Artwork": "الصورة الرئيسية والملصقات",
    "Hero Preview": "معاينة الصورة الرئيسية", "Hero Update Delay": "مهلة تحديث الصورة الرئيسية",
    "Carousel Movement": "حركة صف الملصقات", "Poster Glide": "انزلاق الملصقات",
    "Continuous Hold Scrolling": "التمرير بالضغط المستمر", "Scrolling Animations": "حركة التمرير",
    "Hero Fade": "تلاشي الصورة الرئيسية", "Artwork Fade-in on Entry": "ظهور الملصقات تدريجيًا",
    "Reset Appearance & Motion": "إعادة ضبط المظهر والحركة", "Reset": "إعادة ضبط",
    "On": "مفعّل", "Off": "متوقف", "Glide": "انزلاق", "Instant": "فوري", "Immediate": "فوري",
    "Fade On": "التلاشي مفعّل", "Fade Off": "التلاشي متوقف",
    "Customize navigation, display, and library preferences": "خصّص التنقل والعرض وتفضيلات المكتبة",
    "Continue Watching management, viewing history, recommendation choices": "إدارة متابعة المشاهدة وسجل المشاهدة واختيارات التوصيات",
    "Settings": "الإعدادات", "← Settings": "← الإعدادات", "Content Library": "مكتبة المحتوى",
    "Standard Horizon": "مكتبة هورايزن الإنجليزية", "Arabic Horizon — العربية": "مكتبة هورايزن العربية",
    "Episodes": "الحلقات", "Episode list": "الحلقات", "Seasons": "المواسم",
    "Choose an episode": "اختر حلقة", "Next episode": "الحلقة التالية", "Next Episode": "الحلقة التالية",
    "Previous episode": "الحلقة السابقة", "Previous Episode": "الحلقة السابقة",
    "Resume": "استئناف", "Resume movie": "استئناف الفيلم", "Play movie": "تشغيل الفيلم",
    "Start Over": "البدء من جديد", "Start watching": "ابدأ المشاهدة", "Play": "تشغيل", "Pause": "إيقاف مؤقت",
    "Prev": "السابقة", "Next": "التالية", "Watch Next": "المشاهدة التالية", "Exit": "خروج", "Reload": "إعادة التحميل",
    "Subtitles": "الترجمة", "Subtitles: OFF": "الترجمة: متوقفة", "Subtitles unavailable": "الترجمة غير متاحة",
    "Horizon playback controls": "عناصر التحكم في التشغيل", "Horizon video remote control": "التحكم بالمشغل",
    "Reported playback progress": "تقدم المشاهدة", "Seek timeline": "شريط التقدم",
    "Playback actions": "التحكم في التشغيل", "More player actions": "مزيد من عناصر التحكم",
    "Episode and player actions": "عناصر التحكم في الحلقات", "Additional player actions": "عناصر تحكم إضافية",
    "Loading": "جارٍ التحميل", "Loading…": "جارٍ التحميل…", "Checking availability…": "جارٍ التحقق من التوفر…",
    "Unavailable": "غير متاح", "Playback unavailable": "التشغيل غير متاح",
    "Retry": "إعادة المحاولة", "Searching…": "جارٍ البحث…",
    "Searching Arabic catalog (TMDB · ArabCinemeta · Roya)…": "جارٍ البحث في المكتبة العربية…",
    "No results found.": "لم يتم العثور على نتائج.", "Waiting to search…": "في انتظار البحث…",
    "Enter a title with the remote keyboard or a physical keyboard.": "أدخل عنوانًا باستخدام لوحة المفاتيح.",
    "Enter at least two characters to search, or press OK to submit.": "أدخل حرفين على الأقل، أو اضغط موافق للبحث.",
    "Show Keyboard": "إظهار لوحة المفاتيح", "Hide Keyboard": "إخفاء لوحة المفاتيح",
    "Space": "مسافة", "Clear": "مسح", "More Like This": "عناوين مشابهة",
    "Love It": "أعجبني", "Not Interested": "غير مهتم", "Genre": "النوع", "Length": "المدة",
    "Age Rating": "التصنيف العمري", "Year": "السنة", "Sort": "الترتيب", "Clear Filters": "مسح عوامل التصفية",
    "Closest Matches": "أقرب العناوين", "Same Vibe": "أجواء مشابهة", "Same Genre, Different Story": "النوع نفسه، قصة مختلفة",
    "Hidden Gems": "مختارات قد تعجبك", "Matching Titles": "العناوين المطابقة",
    "Pair Horizon Watch": "إقران الجهاز", "Pair this device to play the selected episode.": "أقرن هذا الجهاز لبدء المشاهدة.",
    "Show pairing code": "عرض رمز الإقران", "Requesting a pairing code…": "جارٍ طلب رمز الإقران…",
    "Pairing ended. Select Show pairing code to try again.": "انتهت مهلة الإقران. اعرض الرمز للمحاولة مجددًا.",
    "Code:": "الرمز:", "Approve it on this Watch site’s /owner page.": "وافق على الإقران من صفحة المالك في هورايزن.",
    "Playback interrupted": "توقف التشغيل", "Playback stopped. Reload resumes from the last confirmed position.": "أعد التحميل للمتابعة من آخر موضع محفوظ.",
    "This playback ticket has reached its renewal limit. Exit and select the episode again.": "انتهت صلاحية التشغيل. ارجع واختر العنوان مرة أخرى.",
    "No verified source is currently available for this selection.": "المشاهدة غير متاحة حاليًا.",
    "Could not start playback. Try Reload.": "تعذر بدء التشغيل. جرّب إعادة التحميل.",
    "Authorizing Roya TV HLS stream…": "جارٍ التحميل…",
    "Checking next episode…": "جارٍ التحقق من الحلقة التالية…",
    "Checking for the next episode": "جارٍ التحقق من الحلقة التالية", "Start watching when episode metadata loads": "جارٍ تحميل الحلقات"
  };

  function ar(value) {
    if (typeof value !== "string") return value;
    if (Object.prototype.hasOwnProperty.call(labels, value)) return labels[value];
    return value.replace(/^Loading Season (\d+)…$/, "جارٍ تحميل الموسم $1…")
      .replace(/^(?:Play )?S(\d+) E(\d+)$/, "الموسم $1 · الحلقة $2")
      .replace(/^Showing (\d+) of (\d+) results$/, "عرض $1 من $2 نتيجة")
      .replace(/^(\d+) recently started titles$/, "$1 عناوين بدأت مشاهدتها مؤخرًا")
      .replace(/^(\d+) titles?$/, "$1 عنوان")
      .replace(/^Season (\d+)$/, "الموسم $1")
      .replace(/^Episode (\d+)$/, "الحلقة $1")
      .replace(/^Season (\d+) · Episode (\d+)/, "الموسم $1 · الحلقة $2")
      .replace(/^(?:Resume|Continue(?: with)?) Season (\d+), Episode (\d+)$/, "متابعة المشاهدة · الموسم $1، الحلقة $2")
      .replace(/^Play Season (\d+), Episode (\d+)$/, "تشغيل الموسم $1، الحلقة $2")
      .replace(/^(\d+) results?\b/, "$1 نتيجة");
  }

  function capture(container) {
    var changes = [];
    var walker = container.ownerDocument.createTreeWalker(container, 4);
    while (walker.nextNode()) {
      var node = walker.currentNode;
      if (node.parentElement.closest("script, style, svg")) continue;
      var original = node.textContent;
      var translated = ar(original.trim());
      if (translated !== original.trim()) changes.push({ node: node, original: original, translated: original.replace(original.trim(), translated) });
    }
    var attrs = ["aria-label", "title", "placeholder"];
    Array.prototype.forEach.call(container.querySelectorAll("[aria-label], [title], [placeholder]"), function (node) {
      attrs.forEach(function (attr) {
        var original = node.getAttribute(attr);
        var translated = ar(original);
        if (translated !== original) changes.push({ node: node, attr: attr, original: original, translated: translated });
      });
    });
    return function (arabic) {
      changes.forEach(function (change) {
        var value = arabic ? change.translated : change.original;
        if (change.attr) change.node.setAttribute(change.attr, value);
        else change.node.textContent = value;
      });
    };
  }

  root.HorizonWatchI18n = { ar: ar, capture: capture };
})(window);
