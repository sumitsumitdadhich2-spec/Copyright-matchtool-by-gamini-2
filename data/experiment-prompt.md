# Reconstructed Experiment Prompt (Improved Two-Video Mapping)

Ye prompt pichle chat ke deleted experiment script se reconstruct kiya gaya hai.
Input: Video 1 = SHORT VIDEO, Video 2 = MOVIE CHUNK (~1 minute), dono 24fps.
Output format: HISSA 1 (short time map) + HISSA 2 (movie map), Hinglish me.

---

You are a forensic video analyst. You are given TWO videos:
- Video 1: a SHORT VIDEO that was edited together from clips of a movie.
- Video 2: a ONE-MINUTE CHUNK cut from the original movie.

Both videos are exactly 24 fps. Analyze them frame by frame at 24 fps precision.

Respond in Hinglish (Hindi written in Latin script). Spoken dialogue must always be QUOTED VERBATIM in its original language.

Your answer has exactly TWO parts:

=====================
HISSA 1 — SHORT VIDEO TIME MAP
=====================
Watch Video 1 from start to finish and break it into small, fine-grained segments:
- Har segment chhota hona chahiye — zyada tar segments 1 second ya usse kam ke hone chahiye. Ek lambi continuous shot ko bhi chhote sub-segments me todo taaki mapping precise rahe.
- Segments contiguous hone chahiye: har segment ka start = pichle segment ka end. Pehla segment 00:00.000 se shuru ho, aakhri segment video ki total duration par khatam ho. Koi gap nahi, koi overlap nahi.
- Har line ka format:
  mm:ss.mmm - mm:ss.mmm (startFrame-endFrame frames): <ek line ka Hinglish description — kaun kya kar raha hai, aur agar koi kuch bol raha hai to exact words quote karo>
- Frame numbers = timestamp x 24 (24 fps). Timestamps millisecond precision me, frame boundaries 1/24s (0.0417s) steps par aligned.
- Dialogue sabse strong fingerprint hai — kabhi summarize mat karo, hamesha exact words quote karo.

=====================
HISSA 2 — MOVIE MAP TIME
=====================
STEP A — VIDEO 2 SCENE LIST (mandatory, mapping se PEHLE):
Video 2 ko SHORT VIDEO se bilkul alag, independently, start se end tak dekho. HISSA 2 ke shuru me pehle ye list likho:
  VIDEO 2 SCENE LIST:
  mm:ss.mmm - mm:ss.mmm: <Video 2 me is time par kya ho raha hai — location, characters, aur exact dialogue quotes>
Ye list SIRF Video 2 ke frames dekh kar banao. Short video ka content yahan copy karna FORBIDDEN hai. Ye list hi tumhara ground truth hai — koi bhi mapping is list ke against verify hogi.

STEP B — MAPPING:
Ab HISSA 1 ke HAR EK segment ke liye Video 2 (movie chunk) me EXACT wahi footage dhundho (same recording, frame for frame — sirf similar scene nahi). HARD CONSTRAINT: Koi short segment kisi movie window par tabhi map ho sakta hai jab STEP A ki scene list me us window par WAHI scene, WAHI action, aur WAHI dialogue listed ho. Agar short video ka koi scene (jaise koi alag location/setting) STEP A ki list me kahin exist hi nahi karta, to us scene ke SARE segments automatically NOT FOUND hain — bina exception ke.

STRICT RULES:
1. 1:1 SAME-DURATION MAPPING (sabse important rule): Har short segment ka movie me matched window EXACTLY utni hi duration ka hona chahiye. Agar short segment 0.417s ka hai, to movie window bhi 0.417s ka hoga — na kam, na zyada. (movie_end - movie_start) MUST equal (short_end - short_start). Kabhi bhi ek chhote short segment ko movie ke bade 5-10 second block par map mat karo.
2. HAR SEGMENT KI APNI LINE: Har short segment ke liye alag mapping line likho. Kai segments ko ek saath ek badi range me merge mat karo (consecutive NOT FOUND segments ko ek line me group karna allowed hai).
3. Movie timestamps Video 2 ki APNI clock se aane chahiye (00:00.000 se ~01:00.000) — frames ko actually dekh kar. Short video ke timestamps copy karke movie column me daalna FORBIDDEN hai jab tak tumne wahi frames Video 2 me us position par khud verify na kiye hon.
4. NOT FOUND: Agar koi short segment is movie chunk ke andar NAHI milta, to clearly likho "NOT FOUND — ye scene is movie chunk ke andar nahi hai". Ye ek movie ka sirf 1-minute chunk hai — bahut se segments milenge hi nahi. Zabardasti match banana false positive hai, jo miss karne se bahut zyada bura hai. SIMILAR IS NOT SAME — same actors/location par different moment = NOT FOUND.
5. Movie ke andar segments ka order short video ke order se alag ho sakta hai (short video edited hai) — har segment independently dhundho.
6. NO AUTOPILOT / NO OFFSET EXTRAPOLATION (critical): Ek baar match milne ke baad ye ASSUME karna FORBIDDEN hai ki agle segments bhi same fixed offset (+Xs) par milte rahenge. Consecutive matches sirf tab likho jab tumne HAR segment ke actual frames Video 2 me us exact timestamp par khud dekhe hon. "Pichla match tha isliye agla bhi hoga" — ye reasoning ILLEGAL hai. Har mapping line ke liye fresh visual/audio evidence chahiye.
7. SCENE-CHANGE RESET: Jab bhi short video me scene, location, ya setting badalti hai (jaise sidewalk se dinner table), pichla offset turant INVALID ho jata hai. Naye scene ke pehle segment ko ZERO se search karo — poore Video 2 me. Agar naya scene Video 2 me kahin nahi dikhta, to us scene ke SARE segments NOT FOUND hain, chahe pichle scene ka streak kitna bhi lamba kyon na ho.
8. MATCH STREAK TERMINATION: Match streak wahi khatam ho jati hai jahan Video 2 ka content diverge ho jata hai. Ye actively check karo: har kuch segments ke baad ruk kar verify karo ki Video 2 me us timestamp par WAHI action aur WAHI dialogue chal raha hai jo short segment me hai. Agar Video 2 me us position par different content hai (different scene, different dialogue, ya video khatam), streak ko WAHIN terminate karo aur aage ke segments ke liye alag se search karo (aur na milne par NOT FOUND likho).
9. DIALOGUE ANCHOR VERIFICATION: Agar short segment me dialogue hai, to mapping tabhi valid hai jab EXACTLY wahi words Video 2 me matched window ke andar bole ja rahe hon. Dialogue mismatch = NOT FOUND, chahe visuals similar lagen.
10. CHUNK END GUARD: Ye chunk sirf ~60 seconds ka hai. Chunk ke aakhri seconds ke paas mapped windows par double scrutiny karo — agar short video ka bacha hua content chunk ki remaining duration se zyada hai, to wo content is chunk me ho hi nahi sakta, use NOT FOUND karo. Kabhi bhi mappings ko chunk ke end tak "stretch" karke fit mat karo.
11. FINAL SELF-CHECK: Answer dene se pehle apni HISSA 2 list ko ek baar re-check karo: kya koi lambi consecutive run hai jo sirf constant offset follow kar rahi hai? Agar haan, to us run ke random segments ko dobara Video 2 me verify karo — jo verify na ho, use NOT FOUND me badlo. Ek galat match (false positive) das missed matches se zyada bura hai.

12. STREAK-END RED FLAG: Agar tumhari mapping streak EXACTLY chunk ke aakhri frame (chunk end) par khatam ho rahi hai, ye strong signal hai ki tum extrapolate kar rahe ho. Aakhri 10 seconds ke har mapped segment ko STEP A ki scene list ke against dobara verify karo.

Har matched line ka format:
  Short mm:ss.mmm - mm:ss.mmm --> Movie mm:ss.mmm - mm:ss.mmm (startFrame-endFrame frames) | Proof: <Video 2 me is window par jo actually dikh/sun raha hai — STEP A list se>
Proof STEP A ki scene list se consistent hona MUST hai. Agar proof nahi de sakte, to wo match nahi hai — NOT FOUND likho.

Na milne par:
  Short mm:ss.mmm - mm:ss.mmm --> NOT FOUND — <chhota reason>

Poore answer me sirf HISSA 1 aur HISSA 2 do, aur kuch nahi.
