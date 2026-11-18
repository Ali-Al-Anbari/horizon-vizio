(function (root) {
  "use strict";

  function normalizeArabic(text) {
    return String(text || "")
      .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
      .replace(/[أإآ]/g, "ا")
      .replace(/ى/g, "ي")
      .replace(/ة/g, "ه")
      .replace(/ؤ/g, "و")
      .replace(/ئ/g, "ي")
      .toLowerCase()
      .replace(/[^\u0600-\u06FFa-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function tokenizeBilingual(text) {
    var norm = normalizeArabic(text);
    return norm ? norm.split(" ").filter(function (part) { return part.length > 0; }) : [];
  }

  function ytThumb(videoId) {
    return "https://i.ytimg.com/vi/" + videoId + "/hqdefault.jpg";
  }

  function buildCatalogNumberedEpisodes(seasonNum, count, titlePrefix, dateYear, stillUrl, runtime) {
    var list = [];
    for (var i = 1; i <= count; i++) {
      list.push({
        number: i,
        title: titlePrefix + " " + i,
        date: dateYear || "",
        runtime: runtime || 45,
        still: stillUrl || null,
        overview: "Verified catalog episode metadata (streaming rights held by external broadcaster/platform; not available as an open in-app stream).",
        availability: "catalog-only"
      });
    }
    return list;
  }

  var ARABIC_TITLES = [
    {
      id: 46707,
      type: "movie",
      title: "المومياء",
      titleAr: "المومياء",
      titleEn: "The Night of Counting the Years",
      aliases: ["al mummia", "the mummy 1969", "shadi abdel salam", "المومياء", "شادي عبد السلام", "day of counting the years"],
      date: "1969-01-27",
      country: "EG",
      countryLabel: "مصر · Egypt",
      regionGroup: "egypt",
      originalLanguage: "ar",
      rating: "NR",
      runtime: 100,
      genres: ["Drama", "History"],
      cast: ["Nadia Lutfi", "Ahmed Marei", "Ahmad Hegazi", "Zouzou Hamdi El-Hakim"],
      network: "Egyptian General Cinema Organization (Public Domain)",
      status: "Released",
      availability: "in-app",
      availabilityLabel: "Play In-App · Archive.org Direct MP4",
      availabilityDetail: "Public-domain Egyptian classic hosted on Internet Archive (direct MP4 stream, no third-party iframe required).",
      poster: "https://image.tmdb.org/t/p/w500/drBl3a8mIM1GEqXljX4CY3sBGw4.jpg",
      backdrop: "https://image.tmdb.org/t/p/w780/drBl3a8mIM1GEqXljX4CY3sBGw4.jpg",
      archiveSource: {
        identifier: "The_Night_of_Counting_the_Years",
        license: "http://creativecommons.org/licenses/publicdomain/",
        streamUrl: "https://archive.org/download/The_Night_of_Counting_the_Years/the-night-of-counting-the-years-1.mp4",
        part2Url: "https://archive.org/download/The_Night_of_Counting_the_Years/the-night-of-counting-the-years-2.mp4",
        format: "mp4",
        quality: "SD / Archival MP4",
        durationSec: 2646,
        subtitleTracks: [
          { lang: "ar", label: "العربية (External)", url: "https://archive.org/download/The_Night_of_Counting_the_Years/the-night-of-counting-the-years-1.ar.srt" },
          { lang: "en", label: "English (External)", url: "https://archive.org/download/The_Night_of_Counting_the_Years/the-night-of-counting-the-years-1.en.srt" }
        ]
      },
      overview: "رائعة المخرج شادي عبد السلام؛ في صعيد مصر عام ١٨٨١، يكتشف شاب من قبيلة الحروبات سر مقبرة المومياوات الملكية في الدير البحري وصراعه بين تقاليد القبيلة وحماية التراث. (Shadi Abdel Salam's 1969 Egyptian masterpiece set in Upper Egypt.)"
    },
    {
      id: 901714,
      externalCatalogId: true,
      royaSeriesId: 1714,
      type: "tv",
      title: "السبع",
      titleAr: "السبع",
      titleEn: "Al-Sabea",
      aliases: ["al sabea", "el sabe3", "sabe3", "السبع 2025", "رمضان 2025", "رؤيا", "roya"],
      date: "2025-03-01",
      country: "SY",
      countryLabel: "سوريا · Syria (Roya TV)",
      regionGroup: "levant",
      originalLanguage: "ar",
      rating: "TV-14",
      episodeRuntime: 43,
      genres: ["Drama", "Action & Adventure"],
      cast: ["Bassem Yakhour", "Abdel Moneim Amayri", "Amal Arafa", "Taysir Idris"],
      network: "Roya TV (Authorized Partner PoC)",
      status: "Ended",
      availability: "in-app",
      availabilityLabel: "Play In-App · Roya TV HLS",
      availabilityDetail: "Authorized Roya TV series playback using Roya Series ID 1714 and KWIKmotion HLS stream tickets.",
      poster: "https://img.roya.tv/imagechanger/Size02Q40R169/storage/app/public/episodes/stream/1714/8c2A25AiWchdNRdivPyWXEVimtCinOVFc6Qm7GpJ.jpg",
      backdrop: "https://img.roya.tv/imagechanger/Size02Q40R169/storage/app/public/episodes/stream/1714/8c2A25AiWchdNRdivPyWXEVimtCinOVFc6Qm7GpJ.jpg",
      overview: "في إطار خيالي، يتناول العمل حياة الغجر، ويسلط الضوء على الصراعات بين عائلتين بسبب المال والنفوذ، حيث يقع حادث مأساوي يؤثر على الجميع. (Levantine Ramadan 2025 drama streaming via Roya TV.)",
      seasons: [
        { number: 1, name: "Season 1 · الموسم الأول (Roya TV Verified)", episodeCount: 2 }
      ],
      seasonEpisodes: {
        1: [
          {
            number: 1,
            royaEpisodeId: 108094,
            title: "الحلقة الأولى · Episode 1",
            date: "2025-03-01",
            runtime: 43,
            durationSec: 2559,
            plus: false,
            still: "https://img.roya.tv/imagechanger/Size02Q40R169/storage/app/public/episodes/stream/1714/8c2A25AiWchdNRdivPyWXEVimtCinOVFc6Qm7GpJ.jpg",
            channel: "Roya TV",
            availability: "in-app",
            overview: "الحلقة الأولى من مسلسل السبع — صراع عائلتين وحادث مأساوي في حياة الغجر."
          },
          {
            number: 2,
            royaEpisodeId: 108106,
            title: "الحلقة الثانية · Episode 2",
            date: "2025-03-02",
            runtime: 43,
            durationSec: 2572,
            plus: false,
            still: "https://img.roya.tv/imagechanger/Size02Q40R169/storage/app/public/episodes/stream/1714/OpjhM0ZYrDzkpyl6FhaW6DwWzD6jox1wGnbTu1wB.jpg",
            channel: "Roya TV",
            availability: "in-app",
            overview: "يقوم فرّاس بتوجيه السبع للقيام بإحدى العمليات الليلية بينما ينقل السبع شكوى الرجال."
          }
        ]
      }
    },
    {
      id: 111075,
      type: "tv",
      title: "لن أعيش في جلباب أبي",
      titleAr: "لن أعيش في جلباب أبي",
      titleEn: "Lan A'ish Fi Gilbab Abi",
      aliases: ["gabal", "gilbab", "abdelghafour el borai", "abdel ghafour", "نور الشريف", "عبلة كامل"],
      date: "1996-01-21",
      country: "EG",
      countryLabel: "مصر · Egypt",
      regionGroup: "egypt",
      originalLanguage: "ar",
      rating: "TV-PG",
      episodeRuntime: 42,
      genres: ["Drama", "Family", "Classic"],
      cast: ["Nour El-Sherif", "Abla Kamel", "Mohamed Riad", "Hanan Tork"],
      network: "Egyptian TV (Maspero Zaman / Maspero Drama)",
      status: "Ended",
      availability: "in-app",
      availabilityLabel: "Play In-App · YouTube Official",
      availabilityDetail: "Verified full episodes hosted by official Egyptian Television channels (Maspero Zaman & Maspero Drama).",
      poster: ytThumb("Uio-5olj0DE"),
      backdrop: ytThumb("Uio-5olj0DE"),
      overview: "يروي المسلسل قصة صعود الحاج عبد الغفور البرعي من وكالة البلح إلى قمة عالم التجارة، وتحديات أبنائه في البحث عن ذواتهم بعيداً عن عباءة الأب. (Classic Egyptian family drama following Hajj Abdel-Ghafour El-Boraie and his children.)",
      seasons: [
        { number: 1, name: "Season 1 · الموسم الأول (Verified Sample Episodes)", episodeCount: 3 }
      ],
      seasonEpisodes: {
        1: [
          {
            number: 1,
            title: "الحلقة ١ · Episode 1 (Full)",
            date: "1996-01-21",
            runtime: 45,
            still: ytThumb("Uio-5olj0DE"),
            youtubeId: "Uio-5olj0DE",
            channel: "ماسبيرو زمان",
            availability: "in-app",
            overview: "البداية في وكالة البلح وصعود الشاب عبد الغفور البرعي تحت رعاية الحاج إبراهيم سردينة."
          },
          {
            number: 2,
            title: "الحلقة ٢ · Episode 2 (Full)",
            date: "1996-01-22",
            runtime: 39,
            still: ytThumb("Ixqus4amNEA"),
            youtubeId: "Ixqus4amNEA",
            channel: "ماسبيرو دراما",
            availability: "in-app",
            overview: "تتوسع تجارة عبد الغفور وتبدأ علاقته بفاطمة كشري في الحارة المصرية."
          },
          {
            number: 3,
            title: "الحلقة ٣ · Episode 3 (Full)",
            date: "1996-01-23",
            runtime: 40,
            still: ytThumb("4CGumtwjHNg"),
            youtubeId: "4CGumtwjHNg",
            channel: "ماسبيرو دراما",
            availability: "in-app",
            overview: "مواجهات التجارة في الوكالة وتثبيت أقدام عبد الغفور في السوق."
          }
        ]
      }
    },
    {
      id: 90674,
      type: "tv",
      title: "رأفت الهجان",
      titleAr: "رأفت الهجان",
      titleEn: "Raafat El-Haggan",
      aliases: ["raafat al haggan", "refaat el gammal", "محمود عبد العزيز", "يسرا", "يوسف شعبان"],
      date: "1988-04-17",
      country: "EG",
      countryLabel: "مصر · Egypt",
      regionGroup: "egypt",
      originalLanguage: "ar",
      rating: "TV-14",
      episodeRuntime: 43,
      genres: ["Thriller", "History", "Drama", "Biography"],
      cast: ["Mahmoud Abdelaziz", "Yousra", "Youssef Shabaan", "Tayseer Fahmy"],
      network: "Egyptian TV (Maspero Drama / ERTU)",
      status: "Ended",
      availability: "in-app",
      availabilityLabel: "Play In-App · YouTube Official",
      availabilityDetail: "Verified full episodes hosted by Maspero Drama & National Media Authority.",
      poster: "https://btttr.cc/poster/imdb/poster-default/tt7302168.jpg?lang=ar",
      backdrop: ytThumb("-Y7uvc7Cmd4"),
      overview: "ملحمة درامية مستوحاة من ملفات المخابرات المصرية عن البطل رفعت علي سليمان الجمال الذي زُرع باسم ديفيد شارل سمحون. (Inspired by the true story of Egyptian intelligence operative Refaat Al-Gammal.)",
      seasons: [
        { number: 1, name: "Season 1 · الجزء الأول (Verified Episodes)", episodeCount: 2 },
        { number: 2, name: "Season 2 · الجزء الثاني (Verified Episode)", episodeCount: 1 }
      ],
      seasonEpisodes: {
        1: [
          {
            number: 1,
            title: "ج١ الحلقة ١ · S1 Episode 1 (Full)",
            date: "1988-04-17",
            runtime: 43,
            still: ytThumb("-Y7uvc7Cmd4"),
            youtubeId: "-Y7uvc7Cmd4",
            channel: "ماسبيرو دراما",
            availability: "in-app",
            overview: "بداية تجنيد رأفت الهجان وإعداده لأخطر مهمة استخباراتية."
          },
          {
            number: 2,
            title: "ج١ الحلقة ٢ · S1 Episode 2 (Full)",
            date: "1988-04-24",
            runtime: 39,
            still: ytThumb("HKNxCayPIKQ"),
            youtubeId: "HKNxCayPIKQ",
            channel: "الهيئة الوطنية للاعلام",
            availability: "in-app",
            overview: "مراحل التدريب وبناء الهوية الجديدة قبل السفر."
          }
        ],
        2: [
          {
            number: 2,
            title: "ج٢ الحلقة ٢ · S2 Episode 2 (Full)",
            date: "1990-03-28",
            runtime: 40,
            still: ytThumb("gPZaje_JRR4"),
            youtubeId: "gPZaje_JRR4",
            channel: "ماسبيرو دراما",
            availability: "in-app",
            overview: "تصاعد الأحداث في الجزء الثاني واستمرار العمل السري."
          }
        ]
      }
    },
    {
      id: 82630,
      type: "tv",
      title: "ليالي الحلمية",
      titleAr: "ليالي الحلمية",
      titleEn: "El-Helmeya Nights",
      aliases: ["layali el helmeya", "helmia", "اسامة انور عكاشة", "سليم البدري", "سليمان غانم"],
      date: "1987-10-18",
      country: "EG",
      countryLabel: "مصر · Egypt",
      regionGroup: "egypt",
      originalLanguage: "ar",
      rating: "TV-PG",
      episodeRuntime: 40,
      genres: ["Drama", "History"],
      cast: ["Yahia El-Fakharany", "Salah El-Saadany", "Safeya El-Emary", "Mamdouh Abdel-Alim"],
      network: "Egyptian TV (Maspero Drama)",
      status: "Ended",
      availability: "in-app",
      availabilityLabel: "Play In-App · YouTube Official",
      availabilityDetail: "Verified full episodes hosted by Maspero Drama.",
      poster: ytThumb("nmeq5l7OvJ8"),
      backdrop: ytThumb("jIVmHU1owT4"),
      overview: "تأريخ درامي لتحولات المجتمع المصري عبر الصراع التاريخي بين سليم باشا البدري والعمدة سليمان غانم في حي الحلمية. (Osama Anwar Okasha's landmark chronicle of modern Egypt.)",
      seasons: [
        { number: 1, name: "Season 1 · الجزء الأول", episodeCount: 1 },
        { number: 2, name: "Season 2 · الجزء الثاني", episodeCount: 1 }
      ],
      seasonEpisodes: {
        1: [
          {
            number: 1,
            title: "ج١ الحلقة ١ · S1 Episode 1 (Full)",
            date: "1987-10-18",
            runtime: 36,
            still: ytThumb("nmeq5l7OvJ8"),
            youtubeId: "nmeq5l7OvJ8",
            channel: "ماسبيرو دراما",
            availability: "in-app",
            overview: "انطلاق الصراع بين سليم البدري وسليمان غانم في حلمية الزيتون."
          }
        ],
        2: [
          {
            number: 3,
            title: "ج٢ الحلقة ٣ · S2 Episode 3 (Full)",
            date: "1989-04-08",
            runtime: 42,
            still: ytThumb("jIVmHU1owT4"),
            youtubeId: "jIVmHU1owT4",
            channel: "ماسبيرو دراما",
            availability: "in-app",
            overview: "فصول جديدة من التحولات الاجتماعية في الجزء الثاني."
          }
        ]
      }
    },
    {
      id: 46369,
      type: "tv",
      title: "باب الحارة",
      titleAr: "باب الحارة",
      titleEn: "Bab Al-Hara",
      aliases: ["bab al hara", "باب الحاره", "حارة الضبع", "ابو عصام", "شام", "سوري"],
      date: "2006-09-24",
      country: "SY",
      countryLabel: "سوريا · Syria",
      regionGroup: "levant",
      originalLanguage: "ar",
      rating: "TV-14",
      episodeRuntime: 41,
      genres: ["Drama", "History"],
      cast: ["Abbas Al-Noury", "Sabah Jazairi", "Ayman Zidan", "Milad Youssef"],
      network: "Bassam Al-Malla Official / Levantine Drama",
      status: "Ended",
      availability: "in-app",
      availabilityLabel: "Play In-App · YouTube Official",
      availabilityDetail: "Verified full episode from Bassam Al-Malla's official YouTube channel.",
      poster: ytThumb("QFnAPmgVtU4"),
      backdrop: ytThumb("QFnAPmgVtU4"),
      overview: "دراما شامية شهيرة ترصد الحياة الاجتماعية والنضال ضد الاستعمار الفرنسي في حارة الضبع بدمشق في عشرينيات وثلاثينيات القرن الماضي. (Iconic Syrian Levantine neighborhood drama set in old Damascus.)",
      seasons: [
        { number: 6, name: "Season 6 · الجزء السادس (Verified Sample)", episodeCount: 1 }
      ],
      seasonEpisodes: {
        6: [
          {
            number: 1,
            title: "ج٦ الحلقة ١ · S6 Episode 1 (Full)",
            date: "2014-06-29",
            runtime: 41,
            still: ytThumb("QFnAPmgVtU4"),
            youtubeId: "QFnAPmgVtU4",
            channel: "القناة الرسمية للمخرج بسام الملا",
            availability: "in-app",
            overview: "عودة أبو عصام المفاجئة إلى حارة الضبع وتطورات الجزء السادس."
          }
        ]
      }
    },
    {
      id: 900001,
      externalCatalogId: true,
      type: "tv",
      title: "بكار",
      titleAr: "بكار",
      titleEn: "Bakkar",
      aliases: ["bakar", "رشيدة", "النوبة", "اطفال", "كرتون عربي"],
      date: "1998-12-20",
      country: "EG",
      countryLabel: "مصر · Egypt",
      regionGroup: "egypt",
      originalLanguage: "ar",
      rating: "TV-G",
      episodeRuntime: 9,
      genres: ["Animation", "Family", "Kids"],
      cast: ["Mona Abou El-Nasr (Creator)", "Mohamed Mounir (Theme)"],
      network: "Egyptian TV (Maspero Kids)",
      status: "Classic",
      availability: "in-app",
      availabilityLabel: "Play In-App · YouTube Official",
      availabilityDetail: "Verified official full episode hosted by Maspero Kids.",
      poster: ytThumb("d6UnSCSGfkQ"),
      backdrop: ytThumb("d6UnSCSGfkQ"),
      overview: "أول شخصية كرتونية مصرية أصيلة؛ مغامرات الطفل النوبي بكار ومعزته رشيدة في ربوع مصر. (Beloved Nubian Egyptian animated series created by Mona Abou El-Nasr.)",
      seasons: [
        { number: 1, name: "Season 1 · الجزء الأول", episodeCount: 1 }
      ],
      seasonEpisodes: {
        1: [
          {
            number: 1,
            title: "ج١ الحلقة ١ · S1 Episode 1 (Full)",
            date: "1998-12-20",
            runtime: 9,
            still: ytThumb("d6UnSCSGfkQ"),
            youtubeId: "d6UnSCSGfkQ",
            channel: "ماسبيرو أطفال",
            availability: "in-app",
            overview: "بداية مغامرات بكار وعنزة النوبة رشيدة."
          }
        ]
      }
    },
    {
      id: 84250,
      type: "movie",
      title: "عسل إسود",
      titleAr: "عسل إسود",
      titleEn: "Asal Eswed (Black Honey)",
      aliases: ["asal eswed", "black honey", "عسل اسود", "احمد حلمي", "ahmed helmy"],
      date: "2010-05-26",
      country: "EG",
      countryLabel: "مصر · Egypt",
      regionGroup: "egypt",
      originalLanguage: "ar",
      rating: "PG-13",
      runtime: 131,
      genres: ["Comedy", "Drama"],
      cast: ["Ahmed Helmy", "Edward", "Lotfy Labib", "Inam Salousa"],
      network: "Rotana Studios (Official Full Movie)",
      status: "Released",
      availability: "in-app",
      availabilityLabel: "Play In-App · YouTube Official",
      availabilityDetail: "Full 131-minute feature film officially published by Rotana Studios on YouTube.",
      poster: "https://btttr.cc/poster/imdb/poster-default/tt2210441.jpg?lang=ar",
      backdrop: "https://d3mfc5qyv0pefp.cloudfront.net/eyJidWNrZXQiOiJ3aXRpbWFnZXMiLCJrZXkiOiJpbWdzL21vdmllcy8xMDQ3OTE2NDI1OTIwODEzNTcucG5nIiwiZWRpdHMiOnsicmVzaXplIjp7IndpZHRoIjoiMTkyMCIsImhlaWdodCI6IjEwODAifSwidG9Gb3JtYXQiOiJ3ZWJwIiwid2VicCI6eyJxdWFsaXR5Ijo3NX19fQ==?signature=b401b7885c37cf074db689f024721ac3478fe5b3e1f0f40d1615c83b714bb8d5",
      youtubeId: "4B8V52OxJvE",
      channel: "Rotana Studios",
      overview: "بعد غياب عشرين عاماً في الولايات المتحدة، يعود مصري سيد العربي إلى وطنه مصر حاملاً جواز سفر أمريكي وتوقعات وردية تصطدم بمفارقات الحياة اليومية. (Ahmed Helmy stars in Khaled Marei's beloved comedy-drama.)"
    },
    {
      id: 113198,
      type: "tv",
      title: "ما وراء الطبيعة",
      titleAr: "ما وراء الطبيعة",
      titleEn: "Paranormal",
      aliases: ["ma waraa al tabiaa", "paranormal", "رفعت اسماعيل", "احمد امين", "أحمد خالد توفيق", "netflix"],
      date: "2020-11-05",
      country: "EG",
      countryLabel: "مصر · Egypt",
      regionGroup: "egypt",
      originalLanguage: "ar",
      rating: "TV-14",
      episodeRuntime: 48,
      genres: ["Mystery", "Drama", "Supernatural"],
      cast: ["Ahmed Amin", "Razane Jammal", "Aya Samaha", "Sama Ibrahim"],
      network: "Netflix Official App",
      status: "Ended",
      availability: "official-app",
      availabilityLabel: "Open on Official App · Netflix",
      availabilityDetail: "Launches the installed LG Netflix webOS app via Luna applicationManager. Active Netflix subscription required.",
      officialApp: { appId: "netflix", appName: "Netflix" },
      poster: "",
      backdrop: "",
      overview: "في ستينيات القرن الماضي، يواجه طبيب أمراض الدم الدكتور رفعت إسماعيل سلسلة من الظواهر الخارقة المستوحاة من سلسلة روايات الدكتور أحمد خالد توفيق. (Egyptian supernatural drama based on Ahmed Khaled Tawfik's novels.)",
      seasons: [
        { number: 1, name: "Season 1 · الموسم الأول (Netflix App)", episodeCount: 6 }
      ],
      seasonEpisodes: {
        1: [
          {
            number: 1,
            title: "أسطورة البيت · The Myth of the House",
            date: "2020-11-05",
            runtime: 47,
            still: null,
            availability: "official-app",
            overview: "Available in the official LG Netflix app."
          }
        ]
      }
    },
    {
      id: 280470,
      type: "movie",
      title: "الفيل الأزرق",
      titleAr: "الفيل الأزرق",
      titleEn: "The Blue Elephant",
      aliases: ["al feel al azraq", "blue elephant", "كريم عبد العزيز", "خالد الصاوي", "نيلي كريم"],
      date: "2014-07-28",
      country: "EG",
      countryLabel: "مصر · Egypt",
      regionGroup: "egypt",
      originalLanguage: "ar",
      rating: "16+",
      runtime: 170,
      genres: ["Thriller", "Drama", "Mystery"],
      cast: ["Karim Abdel Aziz", "Khaled El Sawy", "Nelly Karim", "Lebleba"],
      network: "Official App Partner (Netflix)",
      status: "Released",
      availability: "official-app",
      availabilityLabel: "Open on Official App · Netflix",
      availabilityDetail: "Opens the installed LG Netflix webOS app (regional catalog & subscription required).",
      officialApp: { appId: "netflix", appName: "Netflix" },
      poster: "https://btttr.cc/poster/imdb/poster-default/tt3461252.jpg?lang=ar",
      backdrop: "https://image.tmdb.org/t/p/w1280/eGPSl6OL0c1oTBpHQxtbPhO2mPC.jpg",
      overview: "بعد انقطاع خمس سنوات، يعود الطبيب النفسي يحيى إلى مستشفى العباسية ليُكلف بتقييم حالة مريض في قسم الثامن غربي يكتشف أنه صديقه القديم شريف. (Acclaimed psychological thriller directed by Marwan Hamed.)"
    },
    {
      id: 234790,
      type: "tv",
      title: "الحشاشين",
      titleAr: "الحشاشين",
      titleEn: "Al-Hashashin",
      aliases: ["al hashachin", "assassins", "حسن الصباح", "كريم عبد العزيز", "رمضان 2024"],
      date: "2024-03-11",
      country: "EG",
      countryLabel: "مصر · Egypt",
      regionGroup: "egypt",
      originalLanguage: "ar",
      rating: "TV-MA",
      episodeRuntime: 45,
      genres: ["Drama", "History", "Action & Adventure"],
      cast: ["Karim Abdel Aziz", "Ahmed Eid", "Fathi Abdel Wahab", "Nicolas Mouawad"],
      network: "WATCH IT / Shahid (Metadata Only on LG PoC)",
      status: "Ended",
      availability: "catalog-only",
      availabilityLabel: "Catalog Only · Playback Unavailable",
      availabilityDetail: "Licensed to WATCH IT / Shahid. Shown for Arabic catalog discovery and episode verification without unauthorized scraping.",
      poster: "https://btttr.cc/poster/imdb/poster-default/tt21200366.jpg?lang=ar",
      backdrop: "https://image.tmdb.org/t/p/w1280/lxiVSSy62EgJaCqoL4zw13MokXX.jpg",
      overview: "تدور الأحداث في القرن الحادي عشر حول زعيم طائفة الحشاشين الحسن الصباح وتأسيسه قلعة ألموت وصراعاته السياسية والعقائدية. (Historical epic dramatizing Hassan-i Sabbah and the Order of Assassins.)",
      seasons: [
        { number: 1, name: "Season 1 · الموسم الأول (30 Episodes Verified)", episodeCount: 30 }
      ],
      seasonEpisodes: {
        1: buildCatalogNumberedEpisodes(
          1,
          30,
          "الحلقة · Episode",
          "2024-03-11",
          "https://image.tmdb.org/t/p/w1280/lxiVSSy62EgJaCqoL4zw13MokXX.jpg",
          45
        )
      }
    },
    {
      id: 84242,
      type: "tv",
      title: "الهيبة",
      titleAr: "الهيبة",
      titleEn: "Al Hayba",
      aliases: ["al haiba", "جبل شيخ الجبل", "تيم حسن", "لبنان", "سوريا"],
      date: "2017-05-27",
      country: "LB",
      countryLabel: "لبنان وسوريا · Lebanon / Syria",
      regionGroup: "levant",
      originalLanguage: "ar",
      rating: "TV-14",
      episodeRuntime: 45,
      genres: ["Drama", "Action & Adventure"],
      cast: ["Taim Hasan", "Muna Wassef", "Abdo Shaheen", "Oweiss Mkhallalati"],
      network: "MBC / Shahid (Metadata Only on LG PoC)",
      status: "Ended",
      availability: "catalog-only",
      availabilityLabel: "Catalog Only · Playback Unavailable",
      availabilityDetail: "Exclusive to Shahid / MBC. Included to test multi-season Arabic drama browsing across 5 verified seasons.",
      poster: "https://btttr.cc/poster/imdb/poster-default/tt7035576.jpg?lang=ar",
      backdrop: "https://image.tmdb.org/t/p/w1280/qaKnYL4XAHIdUDoxF3ZGyb8FEaw.jpg",
      overview: "في قرية حدودية بين لبنان وسوريا، يقود جبل شيخ الجبل عشيرته وسط صراعات النفوذ والعائلة والتحديات الأمنية عبر خمسة أجزاء. (Levantine crime-family saga starring Taim Hasan.)",
      seasons: [
        { number: 1, name: "Season 1 · الهيبة (30 eps)", episodeCount: 30 },
        { number: 2, name: "Season 2 · العودة (30 eps)", episodeCount: 30 },
        { number: 3, name: "Season 3 · الحصاد (30 eps)", episodeCount: 30 },
        { number: 4, name: "Season 4 · الرد (30 eps)", episodeCount: 30 },
        { number: 5, name: "Season 5 · جبل (30 eps)", episodeCount: 30 }
      ],
      seasonEpisodes: {
        1: buildCatalogNumberedEpisodes(1, 30, "الحلقة · Episode", "2017-05-27", "https://image.tmdb.org/t/p/w1280/qaKnYL4XAHIdUDoxF3ZGyb8FEaw.jpg", 45),
        2: buildCatalogNumberedEpisodes(2, 30, "الحلقة · Episode", "2018-05-17", "https://image.tmdb.org/t/p/w1280/qaKnYL4XAHIdUDoxF3ZGyb8FEaw.jpg", 45),
        3: buildCatalogNumberedEpisodes(3, 30, "الحلقة · Episode", "2019-05-06", "https://image.tmdb.org/t/p/w1280/qaKnYL4XAHIdUDoxF3ZGyb8FEaw.jpg", 45),
        4: buildCatalogNumberedEpisodes(4, 30, "الحلقة · Episode", "2020-11-01", "https://image.tmdb.org/t/p/w1280/qaKnYL4XAHIdUDoxF3ZGyb8FEaw.jpg", 45),
        5: buildCatalogNumberedEpisodes(5, 30, "الحلقة · Episode", "2021-10-18", "https://image.tmdb.org/t/p/w1280/qaKnYL4XAHIdUDoxF3ZGyb8FEaw.jpg", 45)
      }
    },
    {
      id: 130133,
      type: "tv",
      title: "رشاش",
      titleAr: "رشاش",
      titleEn: "Rashash",
      aliases: ["رشاش العتيبي", "يعقوب الفرحان", "السعودية", "خليجي"],
      date: "2021-07-09",
      country: "SA",
      countryLabel: "السعودية · Saudi Arabia",
      regionGroup: "gulf-iraq",
      originalLanguage: "ar",
      rating: "TV-MA",
      episodeRuntime: 50,
      genres: ["Crime", "Thriller", "Biography"],
      cast: ["Yaqoub Al-Farhan", "Khaled Yeslam", "Naif Aldufairi", "Fayez Bin Jurays"],
      network: "MBC Studios / Shahid (Metadata Only on LG PoC)",
      status: "Ended",
      availability: "catalog-only",
      availabilityLabel: "Catalog Only · Playback Unavailable",
      availabilityDetail: "Shahid VIP Original. Shown for Gulf drama catalog indexing & episode identification.",
      poster: "https://btttr.cc/poster/imdb/poster-default/tt13773600.jpg?lang=ar",
      backdrop: "https://image.tmdb.org/t/p/w1280/byTJiVxot88peCIUxuROkBXGKpx.jpg",
      overview: "دراما جريمة سعودية مستوحاة من أحداث حقيقية في الثمانينيات عن مطاردة أخطر عصابة سطو على الطرق السريعة وتفكيكها أمنياً. (Saudi crime thriller set in the 1980s.)",
      seasons: [
        { number: 1, name: "Season 1 · الموسم الأول (8 Episodes)", episodeCount: 8 }
      ],
      seasonEpisodes: {
        1: buildCatalogNumberedEpisodes(
          1,
          8,
          "الحلقة · Episode",
          "2021-07-09",
          "https://image.tmdb.org/t/p/w1280/byTJiVxot88peCIUxuROkBXGKpx.jpg",
          50
        )
      }
    },
    {
      id: 325482,
      type: "tv",
      title: "حورية",
      titleAr: "حورية",
      titleEn: "Huriya",
      aliases: ["huriya", "حوريا", "دراما عراقية", "العراق", "هبة عادل"],
      date: "2026-06-30",
      country: "IQ",
      countryLabel: "العراق · Iraq",
      regionGroup: "gulf-iraq",
      originalLanguage: "ar",
      rating: "TV-14",
      episodeRuntime: 45,
      genres: ["Drama", "Mystery"],
      cast: ["Heba Adel", "Nagham Al Masoudi", "Zahra Kalkhan", "Yahya Ebrahem"],
      network: "Iraqi Drama (Metadata Only on LG PoC)",
      status: "Returning Series",
      availability: "catalog-only",
      availabilityLabel: "Catalog Only · Playback Unavailable",
      availabilityDetail: "Iraqi drama metadata verified via TMDB / ArabCinemeta without unverified third-party streams.",
      poster: "https://image.tmdb.org/t/p/w500/n1uwhtlaDXxQNXPWSWtPpJ8133W.jpg",
      backdrop: "https://image.tmdb.org/t/p/w1280/ivAE5WeCDIR5VPIZgQagsFamdIX.jpg",
      overview: "حينما يقتحم مجهول حرمة منزل هادئ ويُقتل بداخله، تنقلب حياة حوراء وجدها المريض إلى كابوس مع اختفاء الأدلة. (Iraqi suspense drama verified via TMDB 325482.)",
      seasons: [
        { number: 1, name: "Season 1 · الموسم الأول (8 Episodes)", episodeCount: 8 }
      ],
      seasonEpisodes: {
        1: buildCatalogNumberedEpisodes(
          1,
          8,
          "الحلقة · Episode",
          "2026-06-30",
          "https://image.tmdb.org/t/p/w1280/ivAE5WeCDIR5VPIZgQagsFamdIX.jpg",
          45
        )
      }
    },
    {
      id: 47324,
      type: "movie",
      title: "باب الحديد",
      titleAr: "باب الحديد",
      titleEn: "Cairo Station",
      aliases: ["bab el hadid", "youssef chahine", "يوسف شاهين", "هند رستم"],
      date: "1958-07-31",
      country: "EG",
      countryLabel: "مصر · Egypt",
      regionGroup: "egypt",
      originalLanguage: "ar",
      rating: "NR",
      runtime: 77,
      genres: ["Drama", "Crime"],
      cast: ["Youssef Chahine", "Farid Shawqi", "Hind Rostom"],
      network: "Egyptian Classic Cinema (Catalog Only)",
      status: "Released",
      availability: "catalog-only",
      availabilityLabel: "Catalog Only · Verified TMDB Classic",
      availabilityDetail: "Verified Arabic classic metadata via TMDB 47324 without open in-app stream.",
      poster: "/zm8ET6PSfPT6pozgvjR7htaZFjy.jpg",
      backdrop: "/bYyHPVFXNFAApU6erUCVwARH7rA.jpg",
      overview: "تحفة يوسف شاهين السينمائية حول بائع الصحف قناوي في محطة مصر للقطارات وهوسه ببائعة المشروبات هنومة. (Youssef Chahine's landmark 1958 Egyptian neorealist drama.)"
    },
    {
      id: 44085,
      type: "movie",
      title: "عمارة يعقوبيان",
      titleAr: "عمارة يعقوبيان",
      titleEn: "The Yacoubian Building",
      aliases: ["omaret yacoubian", "ادل امام", "عادل إمام", "مروان حامد"],
      date: "2006-06-01",
      country: "EG",
      countryLabel: "مصر · Egypt",
      regionGroup: "egypt",
      originalLanguage: "ar",
      rating: "R",
      runtime: 161,
      genres: ["Drama"],
      cast: ["Adel Emam", "Nour El-Sherif", "Yousra", "Hend Sabry"],
      network: "Good News Cinema (Catalog Only)",
      status: "Released",
      availability: "catalog-only",
      availabilityLabel: "Catalog Only · Verified TMDB Metadata",
      availabilityDetail: "Verified Arabic feature film metadata via TMDB 44085 without open in-app stream.",
      poster: "/iA0XY4w6Nn7mDVfal7tAgKHqfTu.jpg",
      backdrop: "/dp9o4vhRCVURm9IGK04EcpBLUGC.jpg",
      overview: "بانوراما اجتماعية وسط القاهرة ترصد تحولات المجتمع المصري عبر سكان عمارة يعقوبيان الشهيرة. (Acclaimed adaptation of Alaa Al Aswany's novel.)"
    },
    {
      id: 517814,
      type: "movie",
      title: "كفرناحوم",
      titleAr: "كفرناحوم",
      titleEn: "Capernaum",
      aliases: ["capharnaum", "نادين لبكي", "nadine labaki", "لبنان"],
      date: "2018-09-20",
      country: "LB",
      countryLabel: "لبنان · Lebanon",
      regionGroup: "levant",
      originalLanguage: "ar",
      rating: "R",
      runtime: 126,
      genres: ["Drama"],
      cast: ["Zain Al Rafeea", "Yordanos Shiferaw", "Boluwatife Treasure Bankole"],
      network: "Lebanese Cinema (Catalog Only)",
      status: "Released",
      availability: "catalog-only",
      availabilityLabel: "Catalog Only · Verified TMDB Metadata",
      availabilityDetail: "Oscar-nominated Lebanese drama verified via TMDB 517814 without open in-app stream.",
      poster: "/mFnfTVADj8yOxwzprYOmTPselk8.jpg",
      backdrop: "/sEW8q9al73rtow257dXAusD9yS7.jpg",
      overview: "طفل لبناني يرفع دعوى قضائية ضد والديه في أحياء بيروت الفقيرة بسبب جلبهم له إلى حياة قاسية. (Nadine Labaki's Jury Prize-winning Lebanese drama.)"
    },
    {
      id: 7973,
      type: "movie",
      title: "سكر بنات",
      titleAr: "سكر بنات",
      titleEn: "Caramel",
      aliases: ["sukkar banat", "caramel", "لبنان", "نادين لبكي"],
      date: "2007-08-09",
      country: "LB",
      countryLabel: "لبنان · Lebanon",
      regionGroup: "levant",
      originalLanguage: "ar",
      rating: "PG",
      runtime: 95,
      genres: ["Comedy", "Drama", "Romance"],
      cast: ["Nadine Labaki", "Yasmine Al Massri", "Joanna Moukarzel"],
      network: "Lebanese Cinema (Catalog Only)",
      status: "Released",
      availability: "catalog-only",
      availabilityLabel: "Catalog Only · Verified TMDB Metadata",
      availabilityDetail: "Verified Lebanese comedy-drama via TMDB 7973 without open in-app stream.",
      poster: "/3YAAZuO0Rz33CrIO66NqxMS6R4y.jpg",
      backdrop: "/xg3HpC1I0eDEREqF3RyDY21kzUh.jpg",
      overview: "تتقاطع حكايات خمس نساء داخل صالون تجميل في بيروت حول الحب والتقاليد والحياة اليومية. (Warm ensemble comedy-drama set in a Beirut beauty salon.)"
    },
    {
      id: 129112,
      type: "movie",
      title: "وجدة",
      titleAr: "وجدة",
      titleEn: "Wadjda",
      aliases: ["wadjda", "هيفاء المنصور", "السعودية", "خليجي"],
      date: "2012-12-06",
      country: "SA",
      countryLabel: "السعودية · Saudi Arabia",
      regionGroup: "gulf-iraq",
      originalLanguage: "ar",
      rating: "PG",
      runtime: 98,
      genres: ["Drama", "Family"],
      cast: ["Waad Mohammed", "Reem Abdullah", "Abdullrahman Al Gohani"],
      network: "Saudi Cinema (Catalog Only)",
      status: "Released",
      availability: "catalog-only",
      availabilityLabel: "Catalog Only · Verified TMDB Metadata",
      availabilityDetail: "First Saudi feature film directed by Haifaa Al-Mansour (TMDB 129112).",
      poster: "/7UgPmVd4CxdDnuxVsQ23HuA5WHv.jpg",
      backdrop: "/e7CAgALwH47WEKVqTUfNZO5nPiO.jpg",
      overview: "فتاة سعودية شابة في الرياض تحلم بشراء دراجة هوائية خضراء والمشاركة في مسابقة مدرسية لتحقيق حلمها. (Haifaa Al-Mansour's acclaimed Saudi drama.)"
    }
  ];

  // Technical stream samples strictly labeled as authorized non-Arabic codec/HLS test assets.
  var STREAM_SAMPLES = [
    {
      id: "mux-hls",
      title: "Mux Open Test HLS Stream (.m3u8)",
      subtitle: "Technical HTML5 / webOS Adaptive HLS Compatibility Sample",
      kind: "hls",
      url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"
    },
    {
      id: "w3c-mp4",
      title: "W3C Sintel Trailer (.mp4)",
      subtitle: "Technical HTML5 Progressive MP4 Compatibility Sample",
      kind: "mp4",
      url: "https://media.w3.org/2010/05/sintel/trailer.mp4"
    }
  ];

  function findByKey(type, id) {
    var numId = Number(id);
    for (var i = 0; i < ARABIC_TITLES.length; i++) {
      var item = ARABIC_TITLES[i];
      if ((!type || item.type === type) && item.id === numId) return item;
    }
    return null;
  }

  function findById(id) {
    return findByKey(null, id);
  }

  function extractKeywords(item) {
    var keys = [];
    if (item.country) keys.push("country:" + item.country);
    (item.genres || []).forEach(function (g) { keys.push("genre:" + String(g).toLowerCase()); });
    if (item.date) {
      var dec = Math.floor(parseInt(item.date.slice(0, 4), 10) / 10) * 10;
      if (dec) keys.push("decade:" + dec);
    }
    keys.push("arabic-original");
    return keys;
  }

  function toSearchSummary(item) {
    var gIds = (item.genres || []).map(function (g) { return GENRE_NAME_TO_ID[g] || 18; });
    return {
      id: item.id,
      type: item.type,
      title: item.title + " · " + item.titleEn,
      date: item.date,
      poster: item.poster,
      backdrop: item.backdrop,
      overview: item.overview,
      originalLanguage: item.originalLanguage,
      countryLabel: item.countryLabel,
      genreIds: gIds,
      genre_ids: gIds,
      keywords: extractKeywords(item),
      cast: item.cast || [],
      availability: item.availability,
      availabilityLabel: item.availabilityLabel
    };
  }

  function toDetailPayload(item) {
    if (!item) return null;
    return {
      id: item.id,
      type: item.type,
      title: item.title + " (" + item.titleEn + ")",
      titleAr: item.titleAr,
      titleEn: item.titleEn,
      date: item.date,
      rating: item.rating,
      runtime: item.runtime || null,
      episodeRuntime: item.episodeRuntime || null,
      overview: item.overview,
      poster: item.poster,
      backdrop: item.backdrop,
      genres: item.genres || [],
      cast: item.cast || [],
      network: item.network || "",
      status: item.status || "",
      originalLanguage: "Arabic (العربية) · " + (item.countryLabel || ""),
      seasons: item.seasons || [],
      availability: item.availability,
      availabilityLabel: item.availabilityLabel,
      availabilityDetail: item.availabilityDetail,
      officialApp: item.officialApp || null,
      youtubeId: item.youtubeId || null,
      royaSeriesId: item.royaSeriesId || null,
      channel: item.channel || ""
    };
  }

  function toSeasonPayload(id, seasonNumber) {
    var item = findByKey("tv", id);
    if (!item) return null;
    var sNum = Number(seasonNumber);
    var eps = (item.seasonEpisodes && item.seasonEpisodes[sNum]) ? item.seasonEpisodes[sNum] : [];
    return {
      season: sNum,
      episodes: eps.map(function (ep) {
        return {
          number: ep.number,
          title: ep.title,
          date: ep.date || "",
          runtime: ep.runtime || item.episodeRuntime || 45,
          durationSec: ep.durationSec || null,
          overview: ep.overview || "",
          still: ep.still || item.backdrop || null,
          youtubeId: ep.youtubeId || null,
          royaEpisodeId: ep.royaEpisodeId || null,
          channel: ep.channel || item.network || "",
          availability: ep.availability || item.availability
        };
      })
    };
  }

  function search(query, typeFilter) {
    var q = normalizeArabic(query);
    var tokens = tokenizeBilingual(query);
    var filter = (typeFilter === "movie" || typeFilter === "tv") ? typeFilter : "all";
    if (!q) return [];

    var scored = [];
    for (var i = 0; i < ARABIC_TITLES.length; i++) {
      var item = ARABIC_TITLES[i];
      if (filter !== "all" && item.type !== filter) continue;
      if (item.originalLanguage !== "ar") continue;

      var haystack = normalizeArabic([
        item.titleAr,
        item.titleEn,
        item.countryLabel,
        (item.genres || []).join(" "),
        (item.cast || []).join(" "),
        (item.aliases || []).join(" ")
      ].join(" "));

      var exactNormAr = normalizeArabic(item.titleAr);
      var exactNormEn = normalizeArabic(item.titleEn);
      var matchedAll = tokens.length > 0 && tokens.every(function (tok) {
        return haystack.indexOf(tok) >= 0;
      });
      if (!matchedAll && haystack.indexOf(q) < 0) continue;

      var score = 0;
      if (exactNormAr === q || exactNormEn === q) score += 1000;
      else if (exactNormAr.indexOf(q) === 0 || exactNormEn.indexOf(q) === 0) score += 600;
      else if (exactNormAr.indexOf(q) >= 0 || exactNormEn.indexOf(q) >= 0) score += 350;
      else score += 120;

      if (item.availability === "in-app") score += 40;
      scored.push({ item: item, score: score });
    }

    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.map(function (entry) { return toSearchSummary(entry.item); });
  }

  function filterCatalog(category) {
    var cat = category || "all";
    return ARABIC_TITLES.filter(function (item) {
      if (item.originalLanguage !== "ar") return false;
      if (cat === "all") return true;
      if (cat === "in-app") return item.availability === "in-app";
      if (cat === "official-app") return item.availability === "official-app";
      if (cat === "egypt" || cat === "levant" || cat === "gulf-iraq") {
        return item.regionGroup === cat;
      }
      if (cat === "tv" || cat === "movie") return item.type === cat;
      return true;
    });
  }

  function getPlayableTarget(type, id, season, episode) {
    var item = findByKey(type, id) || findById(id);
    if (!item) return null;

    if (item.availability === "official-app") {
      return {
        mode: "official-app",
        item: item,
        appId: item.officialApp ? item.officialApp.appId : "netflix",
        appName: item.officialApp ? item.officialApp.appName : "Official App",
        episodeObj: null
      };
    }

    if (item.type === "movie") {
      if (item.availability === "in-app" && item.youtubeId) {
        return {
          mode: "youtube",
          item: item,
          youtubeId: item.youtubeId,
          channel: item.channel || item.network,
          title: item.titleAr + " · " + item.titleEn,
          subtitle: item.channel || "Official YouTube Stream"
        };
      }
      return { mode: "catalog-only", item: item };
    }

    var sNum = Number(season || (item.seasons && item.seasons[0] && item.seasons[0].number) || 1);
    var eps = (item.seasonEpisodes && item.seasonEpisodes[sNum]) ? item.seasonEpisodes[sNum] : [];
    var eNum = Number(episode || (eps[0] && eps[0].number) || 1);
    var ep = null;
    for (var i = 0; i < eps.length; i++) {
      if (eps[i].number === eNum) { ep = eps[i]; break; }
    }
    if (!ep && eps.length) ep = eps[0];

    if (ep && ep.availability === "in-app" && ep.youtubeId) {
      return {
        mode: "youtube",
        item: item,
        season: sNum,
        episode: ep.number,
        episodeObj: ep,
        youtubeId: ep.youtubeId,
        channel: ep.channel || item.network,
        title: item.titleAr + " · S" + sNum + " E" + ep.number,
        subtitle: ep.title + (ep.channel ? " — " + ep.channel : "")
      };
    }
    return {
      mode: item.availability === "official-app" ? "official-app" : "catalog-only",
      item: item,
      season: sNum,
      episode: ep ? ep.number : eNum,
      episodeObj: ep || null
    };
  }

  function findPrevVerifiedEpisode(id, season, episode) {
    var item = findByKey("tv", id);
    if (!item || !item.seasonEpisodes) return null;
    var sNum = Number(season);
    var eNum = Number(episode);
    var eps = item.seasonEpisodes[sNum] || [];
    for (var i = 0; i < eps.length; i++) {
      if (eps[i].number === eNum && i - 1 >= 0 && (eps[i - 1].youtubeId || eps[i - 1].royaEpisodeId)) {
        return { season: sNum, episode: eps[i - 1].number };
      }
    }
    var seasonKeys = Object.keys(item.seasonEpisodes).map(Number).sort(function (a, b) { return b - a; });
    for (var s = 0; s < seasonKeys.length; s++) {
      if (seasonKeys[s] < sNum) {
        var prevEps = item.seasonEpisodes[seasonKeys[s]] || [];
        if (prevEps.length) {
          var lastEp = prevEps[prevEps.length - 1];
          if (lastEp && (lastEp.youtubeId || lastEp.royaEpisodeId)) {
            return { season: seasonKeys[s], episode: lastEp.number };
          }
        }
      }
    }
    return null;
  }

  function findNextVerifiedEpisode(id, season, episode) {
    var item = findByKey("tv", id);
    if (!item || !item.seasonEpisodes) return null;
    var sNum = Number(season);
    var eNum = Number(episode);
    var eps = item.seasonEpisodes[sNum] || [];
    for (var i = 0; i < eps.length; i++) {
      if (eps[i].number === eNum && i + 1 < eps.length && (eps[i + 1].youtubeId || eps[i + 1].royaEpisodeId)) {
        return { season: sNum, episode: eps[i + 1].number };
      }
    }
    var seasonKeys = Object.keys(item.seasonEpisodes).map(Number).sort(function (a, b) { return a - b; });
    for (var s = 0; s < seasonKeys.length; s++) {
      if (seasonKeys[s] > sNum) {
        var nextEps = item.seasonEpisodes[seasonKeys[s]] || [];
        if (nextEps.length && (nextEps[0].youtubeId || nextEps[0].royaEpisodeId)) {
          return { season: seasonKeys[s], episode: nextEps[0].number };
        }
      }
    }
    return null;
  }

  var GENRE_NAME_TO_ID = {
    "Drama": 18, "Comedy": 35, "Action & Adventure": 10759, "Action": 28,
    "Crime": 80, "Mystery": 9648, "Family": 10751, "Animation": 16,
    "History": 36, "Thriller": 53, "Romance": 10749, "Kids": 10762
  };

  function toHomeCandidate(item, idx) {
    var runtime = item.type === "movie" ? (item.runtime || 100) : (item.episodeRuntime || 42);
    var genreIds = (item.genres || []).map(function (g) { return GENRE_NAME_TO_ID[g] || 18; });
    return {
      id: item.id,
      type: item.type,
      title: item.title + " · " + item.titleEn,
      date: item.date,
      poster: item.poster || item.backdrop || "",
      backdrop: item.backdrop || item.poster || "",
      overview: item.overview,
      originalLanguage: "ar",
      countryLabel: item.countryLabel,
      rating: item.rating || null,
      runtime: runtime,
      episodeRuntime: item.type === "tv" ? runtime : null,
      genreIds: genreIds,
      genre_ids: genreIds,
      keywords: extractKeywords(item),
      cast: item.cast || [],
      voteCount: item.availability === "in-app" ? 280 : 180,
      voteAverage: item.availability === "in-app" ? 8.4 : 7.8,
      popularity: 100 - idx,
      sources: [{ kind: idx < 4 ? "recommendation" : "similar", rank: idx }],
      matchReason: item.availability === "in-app"
        ? (item.archiveSource ? "Open MP4 · " : "Play In-App · ") + item.countryLabel
        : item.countryLabel
    };
  }

  function selectHomeRows(historyRows, feedback) {
    var ratings = (feedback && feedback.ratings) ? feedback.ratings : {};
    var eligible = ARABIC_TITLES.map(toHomeCandidate).filter(function (c) {
      return ratings[c.type + ":" + c.id] !== "disliked";
    });
    if (!eligible.length) eligible = ARABIC_TITLES.map(toHomeCandidate);

    var tvAll = eligible.filter(function (c) { return c.type === "tv"; });
    var movieAll = eligible.filter(function (c) { return c.type === "movie"; });

    var playable = eligible.filter(function (c) {
      var orig = findByKey(c.type, c.id);
      return orig && orig.availability === "in-app";
    });
    var regionalMix = eligible.filter(function (c) {
      return playable.indexOf(c) < 0;
    });

    var seedItem = ARABIC_TITLES[0];
    if (Array.isArray(historyRows)) {
      for (var i = 0; i < historyRows.length; i++) {
        var matched = findByKey(historyRows[i].type, historyRows[i].id);
        if (matched) { seedItem = matched; break; }
      }
    }

    return {
      seed: {
        type: seedItem.type,
        id: seedItem.id,
        title: seedItem.titleAr + " · " + seedItem.titleEn,
        liked: ratings[seedItem.type + ":" + seedItem.id] === "liked"
      },
      top: playable.concat(regionalMix).slice(0, 10),
      because: eligible.slice(1, 9),
      trending: eligible.slice(0, 10),
      gems: regionalMix.concat(playable).slice(0, 8),
      explore: tvAll.slice(2).concat(movieAll.slice(2)).slice(0, 8),
      tv: {
        recommended: tvAll.slice(0, 10),
        trending: tvAll.slice().reverse().slice(0, 10),
        genres: tvAll.filter(function (c) { return c.genreIds.indexOf(18) >= 0; }),
        genresHeading: "Arabic Drama Series",
        short: tvAll.filter(function (c) { return (c.episodeRuntime || 45) <= 40; }),
        gems: tvAll.slice(3).concat(tvAll.slice(0, 3)).slice(0, 8),
        acclaimed: tvAll.slice(0, 8)
      },
      movies: {
        recommended: movieAll.slice(0, 10),
        trending: movieAll.slice().reverse().slice(0, 10),
        genres: movieAll.filter(function (c) { return c.genreIds.indexOf(18) >= 0; }),
        genresHeading: "Arabic Cinema",
        short: movieAll.filter(function (c) { return (c.runtime || 120) <= 105; }),
        acclaimed: movieAll.slice(0, 8),
        gems: movieAll.slice(2).concat(movieAll.slice(0, 2)).slice(0, 8)
      }
    };
  }

  function filterDiscover(params) {
    var type = params.get("type") === "tv" ? "tv" : "movie";
    var withGenre = Number(params.get("with_genres")) || 0;
    var yearFilter = params.get("year") || "";
    var lengthFilter = params.get("length") || "";
    var sortBy = params.get("sort_by") || "";

    var rows = ARABIC_TITLES.filter(function (item) {
      if (item.type !== type) return false;
      if (withGenre) {
        var gIds = (item.genres || []).map(function (g) { return GENRE_NAME_TO_ID[g] || 0; });
        if (gIds.indexOf(withGenre) < 0) return false;
      }
      if (yearFilter) {
        var y = Number(String(item.date || "").slice(0, 4));
        if (yearFilter === "2020s" && y < 2020) return false;
        if (yearFilter === "2010s" && (y < 2010 || y >= 2020)) return false;
        if (yearFilter === "classic" && y >= 2000) return false;
      }
      if (lengthFilter) {
        var rt = item.type === "movie" ? (item.runtime || 100) : (item.episodeRuntime || 45);
        if (lengthFilter === "short" && rt > (type === "tv" ? 30 : 100)) return false;
        if (lengthFilter === "long" && rt < (type === "tv" ? 45 : 130)) return false;
      }
      return true;
    }).map(function (item, idx) { return toHomeCandidate(item, idx); });

    if (sortBy.indexOf("date.desc") >= 0) {
      rows.sort(function (a, b) { return String(b.date || "").localeCompare(String(a.date || "")); });
    }
    return { results: rows };
  }

  function similarTitles(type, id, target, avoid) {
    var seed = findByKey(type, Number(id)) || ARABIC_TITLES[0];
    var avoidSet = Object.create(null);
    String(avoid || "").split(",").forEach(function (k) { if (k) avoidSet[k] = true; });
    var targetType = (target === "tv" || target === "movie") ? target : seed.type;
    var candidates = ARABIC_TITLES.filter(function (item) {
      if (item.type === seed.type && item.id === seed.id) return false;
      if (avoidSet[item.type + ":" + item.id]) return false;
      return target === "both" || item.type === targetType;
    }).map(function (item, idx) { return toHomeCandidate(item, idx); });

    return {
      seed: toSearchSummary(seed),
      candidates: candidates
    };
  }

  root.HorizonArabicCatalog = {
    ARABIC_TITLES: ARABIC_TITLES,
    STREAM_SAMPLES: STREAM_SAMPLES,
    normalizeArabic: normalizeArabic,
    tokenizeBilingual: tokenizeBilingual,
    findByKey: findByKey,
    findById: findById,
    toSearchSummary: toSearchSummary,
    toDetailPayload: toDetailPayload,
    toSeasonPayload: toSeasonPayload,
    search: search,
    filterCatalog: filterCatalog,
    selectHomeRows: selectHomeRows,
    filterDiscover: filterDiscover,
    similarTitles: similarTitles,
    getPlayableTarget: getPlayableTarget,
    findPrevVerifiedEpisode: findPrevVerifiedEpisode,
    findNextVerifiedEpisode: findNextVerifiedEpisode
  };
})(typeof window !== "undefined" ? window : globalThis);
