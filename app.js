(() => {
  "use strict";

  const C = window.SITE_CONFIG;
  const D = window.SITE_DATA;
  const Cesium = window.Cesium;

  const FLOOR_H = 3.15; // estimated floor-to-floor height (m)
  // Height of the first residential level above ground: Classic towers sit on a carpark storey.
  const FIRST_LEVEL_Z = { Classic: 4.5, Luxury: 1.0 };
  const PRIVATE_LIFT = new Set(["4BRP", "4BRPS", "5BR"]);
  const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const DIM_COLOR = Cesium.Color.fromCssColorString("#dcd8cf");
  const SELECT_COLOR = Cesium.Color.fromCssColorString("#fff04d");

  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, "0");
  const compassPoint = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
  const baseType = (code) => code.replace(/p( \(L\))?$/, "$1");

  // ---------------------------------------------------------------- data
  const categories = new Map(D.categories.map((c) => [c.id, c]));
  const blocks = D.blocks.map((b) => {
    const [first, last] = b.levels;
    const z0 = FIRST_LEVEL_Z[b.collection];
    return { ...b, first, last, z0, roof: z0 + (last - first + 1) * FLOOR_H };
  });
  const blockById = new Map(blocks.map((b) => [b.id, b]));

  const units = D.units.map(([blockId, level, stack, code]) => {
    const block = blockById.get(blockId);
    const type = D.types[code];
    const s = D.stacks[stack];
    const z = block.z0 + (level - block.first) * FLOOR_H;
    return {
      id: `${stack}-${level}`,
      block, level, stack, code, type,
      category: categories.get(type.category),
      label: `#${pad(level)}-${stack}`,
      bearing: s.bearing,
      facing: compassPoint(s.bearing),
      z0: z, z1: z + FLOOR_H,
    };
  });
  const unitsById = new Map(units.map((u) => [u.id, u]));

  // ---------------------------------------------------------------- viewer
  const viewer = new Cesium.Viewer("viewer", {
    baseLayer: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    skyBox: false,
    shadows: true,
    terrainShadows: Cesium.ShadowMode.RECEIVE_ONLY,
  });
  const scene = viewer.scene;
  const camera = viewer.camera;
  scene.globe.baseColor = Cesium.Color.fromCssColorString("#e8e3d6");
  scene.globe.showGroundAtmosphere = false;
  scene.backgroundColor = Cesium.Color.fromCssColorString("#dfe9f1");
  scene.skyAtmosphere.show = false;
  scene.screenSpaceCameraController.minimumZoomDistance = 3;
  viewer.clock.shouldAnimate = false;
  viewer.shadowMap.softShadows = true;
  viewer.shadowMap.darkness = 0.62;
  viewer.shadowMap.maximumDistance = 1500;

  // Soft, bright shading for the massing model: a strong ambient term plus sun-facing diffuse,
  // so facades away from the sun keep their colour (shadows are still applied on top).
  const SHADED_FS = `
    in vec3 v_positionEC;
    in vec3 v_normalEC;
    in vec4 v_color;
    void main() {
      vec3 normalEC = normalize(v_normalEC);
    #ifdef FACE_FORWARD
      normalEC = faceforward(normalEC, vec3(0.0, 0.0, 1.0), -normalEC);
    #endif
      vec4 color = czm_gammaCorrect(v_color);
      float diffuse = max(dot(normalEC, czm_lightDirectionEC), 0.0);
      out_FragColor = vec4(color.rgb * (0.7 + 0.4 * diffuse), color.a);
    }`;
  const shaded = (closed = true) =>
    new Cesium.PerInstanceColorAppearance({ flat: false, closed, fragmentShaderSource: SHADED_FS });

  let baseHeight = 0;
  let transform = makeTransform();
  let unitPrimitive = null;
  let otherPrimitives = [];
  const siteSource = new Cesium.CustomDataSource("site");
  viewer.dataSources.add(siteSource);

  function makeTransform() {
    return Cesium.Transforms.eastNorthUpToFixedFrame(
      Cesium.Cartesian3.fromDegrees(D.origin.lng, D.origin.lat, baseHeight));
  }
  function toWorld(e, n, z = 0) {
    return Cesium.Matrix4.multiplyByPoint(transform, new Cesium.Cartesian3(e, n, z), new Cesium.Cartesian3());
  }
  function placed(e, n, z) {
    return Cesium.Matrix4.multiply(transform,
      Cesium.Matrix4.fromTranslation(new Cesium.Cartesian3(e, n, z)), new Cesium.Matrix4());
  }

  function insidePolygon([x, y], poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // Seeded random so tree placement is the same on every load.
  function rng(seed) {
    return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  }

  function onReady(primitive, cb) {
    if (primitive.ready) return cb();
    const remove = scene.postRender.addEventListener(() => {
      if (primitive.ready) { remove(); cb(); }
    });
  }

  // Footprint (in local metres) extruded between two heights above the site ground.
  function prism(outline, z0, z1, color, id) {
    return new Cesium.GeometryInstance({
      geometry: new Cesium.PolygonGeometry({
        polygonHierarchy: new Cesium.PolygonHierarchy(outline.map(([e, n]) => toWorld(e, n))),
        height: baseHeight + z0,
        extrudedHeight: baseHeight + z1,
        vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
      }),
      id,
      attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(color) },
    });
  }
  // Flat polygon just above the ground.
  function flat(outline, z, color) {
    return new Cesium.GeometryInstance({
      geometry: new Cesium.PolygonGeometry({
        polygonHierarchy: new Cesium.PolygonHierarchy(outline.map(([e, n]) => toWorld(e, n))),
        height: baseHeight + z,
        vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
      }),
      attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(color) },
    });
  }

  function buildScene() {
    transform = makeTransform();
    if (unitPrimitive) scene.primitives.remove(unitPrimitive);
    otherPrimitives.forEach((p) => scene.primitives.remove(p));
    otherPrimitives = [];
    siteSource.entities.removeAll();

    // One prism per home, slightly shorter than a storey so the slab lines show.
    unitPrimitive = scene.primitives.add(new Cesium.Primitive({
      geometryInstances: units.map((u) =>
        prism(D.stacks[u.stack].outline, u.z0 + 0.08, u.z1 - 0.08, unitColor(u), u.id)),
      appearance: shaded(),
      shadows: Cesium.ShadowMode.ENABLED,
    }));

    // Tower cores, carpark podiums and roofs.
    const parts = [];
    const core = Cesium.Color.fromCssColorString("#bdb7ab");
    const podium = Cesium.Color.fromCssColorString("#d9d3c5");
    const roof = Cesium.Color.fromCssColorString("#f6f4ef");
    blocks.forEach((b) => {
      parts.push(prism(b.core, 0, b.roof, core));
      if (b.z0 > 2) parts.push(prism(b.outline, 0, b.z0, podium));
      parts.push(prism(b.outline, b.roof, b.roof + 1.2, roof));
      parts.push(prism(b.core, b.roof + 1.2, b.roof + 5, roof));
    });

    // Trees scattered over the landscaped grounds, away from towers and pools.
    const rand = rng(11);
    const tree = new Cesium.EllipsoidGeometry({
      radii: new Cesium.Cartesian3(3.4, 3.4, 4),
      vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
    });
    const xs = D.site.map((p) => p[0]);
    const ys = D.site.map((p) => p[1]);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const nearTower = (p) => blocks.some((b) => Math.hypot(p[0] - b.center[0], p[1] - b.center[1]) < 34);
    let planted = 0;
    for (let i = 0; i < 20000 && planted < 320; i++) {
      const p = [minX + rand() * (maxX - minX), minY + rand() * (maxY - minY)];
      if (!insidePolygon(p, D.site) || nearTower(p) || D.pools.some((pool) => insidePolygon(p, pool))) continue;
      const shade = 0.7 + rand() * 0.3;
      parts.push(new Cesium.GeometryInstance({
        geometry: tree,
        modelMatrix: placed(p[0], p[1], 4.6 + rand() * 1.5),
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(
            new Cesium.Color(0.3 * shade, 0.55 * shade, 0.27 * shade, 1)),
        },
      }));
      planted++;
    }
    otherPrimitives.push(scene.primitives.add(new Cesium.Primitive({
      geometryInstances: parts,
      appearance: shaded(),
      shadows: Cesium.ShadowMode.ENABLED,
      allowPicking: false,
    })));

    // Landscape: lawn over the whole site, then the pools.
    otherPrimitives.push(scene.primitives.add(new Cesium.Primitive({
      geometryInstances: [
        flat(D.site, 0.15, Cesium.Color.fromCssColorString("#a7c785")),
        ...D.pools.map((p) => flat(p, 0.3, Cesium.Color.fromCssColorString("#5ec3df"))),
      ],
      appearance: shaded(false),
      shadows: Cesium.ShadowMode.RECEIVE_ONLY,
      allowPicking: false,
    })));

    blocks.forEach((b) => {
      siteSource.entities.add({
        position: toWorld(b.center[0], b.center[1], b.roof + 10),
        label: {
          text: `BLK ${b.id}`,
          font: "600 13px Inter, sans-serif",
          fillColor: Cesium.Color.WHITE,
          showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString(b.collection === "Luxury" ? "#6a2c5c" : "#1f4d4f")
            .withAlpha(0.88),
          backgroundPadding: new Cesium.Cartesian2(8, 5),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    });

    selectionLabel = siteSource.entities.add({
      show: false,
      position: toWorld(0, 0, 0),
      label: {
        text: "",
        font: "700 14px Inter, sans-serif",
        fillColor: Cesium.Color.fromCssColorString("#1f2a2e"),
        showBackground: true,
        backgroundColor: SELECT_COLOR,
        backgroundPadding: new Cesium.Cartesian2(8, 5),
        pixelOffset: new Cesium.Cartesian2(0, -14),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });

    onReady(unitPrimitive, refreshColors);
    if (selected) showSelectionLabel(selected);
  }

  // ---------------------------------------------------------------- colours & filters
  const filter = { beds: null, collection: null, category: null, type: null };
  let selected = null;
  let selectionLabel = null;

  function matches(u) {
    return (filter.beds === null || u.category.beds === filter.beds) &&
      (filter.collection === null || u.block.collection === filter.collection) &&
      (filter.category === null || u.category.id === filter.category) &&
      (filter.type === null || baseType(u.code) === filter.type);
  }
  function unitColor(u) {
    if (selected === u) return SELECT_COLOR;
    if (!matches(u)) return DIM_COLOR;
    return Cesium.Color.fromCssColorString(u.category.color);
  }
  function refreshColors() {
    if (!unitPrimitive || !unitPrimitive.ready) return;
    for (const u of units) {
      const attrs = unitPrimitive.getGeometryInstanceAttributes(u.id);
      if (attrs) attrs.color = Cesium.ColorGeometryInstanceAttribute.toValue(unitColor(u), attrs.color);
    }
  }

  function chip(text, active, onclick, color) {
    const b = document.createElement("button");
    b.className = "chip" + (active ? " active" : "");
    if (color) {
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = color;
      b.appendChild(dot);
    }
    b.appendChild(document.createTextNode(text));
    b.onclick = onclick;
    return b;
  }

  const bedCounts = [...new Set(D.categories.map((c) => c.beds))].sort();
  function renderFilters() {
    const el = $("filters");
    el.replaceChildren();
    const none = filter.beds === null && filter.category === null && filter.type === null;
    el.appendChild(chip("All", none, () => setFilter({ beds: null })));
    bedCounts.forEach((beds) => el.appendChild(chip(`${beds} Bed`, filter.beds === beds, () => setFilter({ beds }))));
    const sep = document.createElement("span");
    sep.className = "sep";
    el.appendChild(sep);
    ["Classic", "Luxury"].forEach((c) => el.appendChild(chip(c, filter.collection === c,
      () => setFilter({ collection: filter.collection === c ? null : c }, false))));
    if (filter.type) el.appendChild(chip(`Type ${filter.type} ×`, true, () => setFilter({ type: null })));
    renderLegend();
  }
  // Bedroom, category and type filters replace each other; the collection filter combines with them.
  function setFilter(change, exclusive = true) {
    if (exclusive) Object.assign(filter, { beds: null, category: null, type: null });
    Object.assign(filter, change);
    renderFilters();
    refreshColors();
  }

  function renderLegend() {
    const el = $("legend");
    el.replaceChildren();
    D.categories.forEach((c) => {
      const count = units.filter((u) => u.category === c &&
        (filter.collection === null || u.block.collection === filter.collection)).length;
      if (!count) return;
      const row = document.createElement("button");
      row.className = "legend-row" + (filter.category === c.id ? " active" : "");
      row.innerHTML = `<span class="dot" style="background:${c.color}"></span><span></span><b>${count}</b>`;
      row.children[1].textContent = c.label;
      row.onclick = () => setFilter({ category: filter.category === c.id ? null : c.id });
      el.appendChild(row);
    });
  }

  // ---------------------------------------------------------------- camera
  // The site is a long NW-SE crescent: landscape screens view it side-on from the south-west,
  // portrait screens look along it from the south-east so the whole site fits.
  const portrait = () => scene.canvas.clientWidth < scene.canvas.clientHeight;
  let viewHeading = portrait() ? 320 : 35;
  function flyOverview(headingDeg = viewHeading, duration = 1.6) {
    viewHeading = headingDeg;
    camera.flyToBoundingSphere(new Cesium.BoundingSphere(toWorld(0, 0, 30), 260), {
      offset: new Cesium.HeadingPitchRange(
        Cesium.Math.toRadians(headingDeg), Cesium.Math.toRadians(-30), portrait() ? 760 : 640),
      duration,
    });
    $("btn-overview").hidden = true;
  }

  const stackCenter = (u) => D.stacks[u.stack].center;

  function flyToUnit(u) {
    const [e, n] = stackCenter(u);
    camera.flyToBoundingSphere(new Cesium.BoundingSphere(toWorld(e, n, (u.z0 + u.z1) / 2), 12), {
      offset: new Cesium.HeadingPitchRange(
        Cesium.Math.toRadians(u.bearing + 180), Cesium.Math.toRadians(-12), 150),
      duration: 1.4,
    });
    $("btn-overview").hidden = false;
  }

  function viewFromUnit(u) {
    const [e, n] = stackCenter(u);
    const r = Cesium.Math.toRadians(u.bearing);
    const outline = D.stacks[u.stack].outline;
    // Step outwards from the middle of the unit until just past its facade.
    let d = 0;
    while (d < 40 && insidePolygon([e + Math.sin(r) * d, n + Math.cos(r) * d], outline)) d += 0.5;
    camera.flyTo({
      destination: toWorld(e + Math.sin(r) * (d + 1.5), n + Math.cos(r) * (d + 1.5), u.z0 + 1.6),
      orientation: { heading: r, pitch: Cesium.Math.toRadians(-6), roll: 0 },
      duration: 2,
    });
    $("btn-overview").hidden = false;
  }

  // Compass: the needle follows the camera; clicking orbits to the next side of the site.
  const SIDES = [["S", 0], ["W", 90], ["N", 180], ["E", 270]];
  let sideIdx = -1;
  scene.postRender.addEventListener(() => {
    $("needle").style.transform = `rotate(${-Cesium.Math.toDegrees(camera.heading)}deg)`;
  });
  $("compass").onclick = () => {
    sideIdx = (sideIdx + 1) % 4;
    $("compass-label").textContent = `View from ${SIDES[(sideIdx + 1) % 4][0]}`;
    flyOverview(SIDES[sideIdx][1], 1.2);
  };

  // ---------------------------------------------------------------- selection UI
  const selBlock = $("sel-block");
  const selLevel = $("sel-level");
  const selUnit = $("sel-unit");

  function option(value, text) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = text;
    return o;
  }
  function fillBlocks() {
    selBlock.replaceChildren(option("", "Block"),
      ...blocks.map((b) => option(b.id, `${b.name} · ${b.collection}`)));
  }
  function fillLevels() {
    const b = blockById.get(selBlock.value);
    const opts = [option("", "Level")];
    if (b) for (let l = b.last; l >= b.first; l--) opts.push(option(l, `Level ${l}`));
    selLevel.replaceChildren(...opts);
  }
  function fillUnits() {
    const level = Number(selLevel.value);
    const list = units.filter((u) => u.block.id === selBlock.value && u.level === level);
    selUnit.replaceChildren(option("", "Unit"),
      ...list.map((u) => option(u.id, `${u.label} · ${u.code} · ${u.category.label}`)));
  }
  selBlock.onchange = () => {
    fillLevels();
    fillUnits();
    const b = blockById.get(selBlock.value);
    if (b) {
      camera.flyToBoundingSphere(new Cesium.BoundingSphere(toWorld(b.center[0], b.center[1], b.roof / 2), 55), {
        offset: new Cesium.HeadingPitchRange(Cesium.Math.toRadians(viewHeading), Cesium.Math.toRadians(-15), 240),
        duration: 1.4,
      });
      $("btn-overview").hidden = false;
    }
  };
  selLevel.onchange = fillUnits;
  selUnit.onchange = () => selUnit.value && selectUnit(unitsById.get(selUnit.value));

  $("search-form").onsubmit = (e) => {
    e.preventDefault();
    const m = $("search").value.match(/(\d{1,2})\s*-\s*(\d{1,2})/);
    const u = m && unitsById.get(`${pad(Number(m[2]))}-${Number(m[1])}`);
    if (u) selectUnit(u);
    else flash(`No unit "${$("search").value}" — try a unit number like #12-25`);
  };

  function sunNote(facing) {
    if (facing.includes("W")) return "Gets afternoon and evening sun — warmer in the late afternoon.";
    if (facing.includes("E")) return "Gets gentle morning sun — cooler in the afternoon.";
    return "North/South-facing — minimal direct sun, generally the coolest orientation in Singapore.";
  }

  function showSelectionLabel(u) {
    const [e, n] = stackCenter(u);
    selectionLabel.position = toWorld(e, n, u.z1);
    selectionLabel.label.text = u.label;
    selectionLabel.show = true;
  }

  function selectUnit(u, fly = true) {
    selected = u;
    refreshColors();
    showSelectionLabel(u);

    selBlock.value = u.block.id;
    fillLevels();
    selLevel.value = u.level;
    fillUnits();
    selUnit.value = u.id;

    $("card-title").textContent = u.label;
    $("card-sub").textContent = `${u.block.name} · ${u.category.label}`;
    $("card-chips").replaceChildren(...[
      `Type ${u.code}`,
      `${u.type.sqm} sqm · ${u.type.sqft.toLocaleString()} sqft`,
      `Faces ${u.facing}`,
      `Level ${u.level}`,
      `${u.block.collection} Collection`,
    ].map((t) => {
      const s = document.createElement("span");
      s.textContent = t;
      return s;
    }));
    const notes = [sunNote(u.facing)];
    if (PRIVATE_LIFT.has(u.category.id)) notes.unshift("Private lift access.");
    if (u.type.pes) notes.unshift("Lowest residential level, with a private enclosed space (PES).");
    $("card-notes").replaceChildren(...notes.map((t) => {
      const li = document.createElement("li");
      li.textContent = t;
      return li;
    }));
    $("card-plan").href = u.type.plan;
    $("card-plan-img").src = u.type.plan;
    $("card-plan-img").alt = `Floor plan, type ${u.code}`;
    $("btn-wa").hidden = !C.whatsappNumber;
    $("btn-wa").href = whatsappLink(
      `Hi, I'm interested in ${C.projectName} unit ${u.label} (${u.block.name}, type ${u.code}, ` +
      `${u.category.label}). Could you share the price and availability?`);
    $("btn-brochure").onclick = () => {
      $("reg-unit").value = `${u.label} · ${u.block.name} · type ${u.code} (${u.category.label})`;
    };
    $("unit-card").hidden = false;
    if (fly) flyToUnit(u);
  }

  function clearSelection() {
    selected = null;
    selectionLabel.show = false;
    $("unit-card").hidden = true;
    refreshColors();
  }
  $("card-close").onclick = clearSelection;
  $("btn-overview").onclick = () => flyOverview(viewHeading);
  $("btn-view-from").onclick = async () => {
    if (!selected) return;
    const u = selected;
    if (!realCity && C.googleMapsApiKey) {
      $("real-city").checked = true;
      await setRealCity(true);
    }
    if (window.matchMedia("(max-width: 760px)").matches) $("unit-card").hidden = true;
    viewFromUnit(u);
  };

  // Click and hover on units.
  const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
  const pickUnit = (pos) => {
    const picked = scene.pick(pos);
    return picked && typeof picked.id === "string" ? unitsById.get(picked.id) : undefined;
  };
  handler.setInputAction((e) => {
    const u = pickUnit(e.position);
    if (u) selectUnit(u);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  const tooltip = $("tooltip");
  let hoverPos = null;
  handler.setInputAction((e) => { hoverPos = e.endPosition; }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
  scene.postRender.addEventListener(() => {
    if (!hoverPos) return;
    const pos = hoverPos;
    hoverPos = null;
    const u = pickUnit(pos);
    if (!u) { tooltip.hidden = true; scene.canvas.style.cursor = ""; return; }
    tooltip.textContent = `${u.block.name} ${u.label} · ${u.code} · ${u.category.label} · ` +
      `${u.type.sqft.toLocaleString()} sqft · ${u.facing}`;
    tooltip.style.left = `${pos.x}px`;
    tooltip.style.top = `${pos.y}px`;
    tooltip.hidden = false;
    scene.canvas.style.cursor = "pointer";
  });

  // ---------------------------------------------------------------- sun & shadows
  const sunTime = $("sun-time");
  const now = new Date();
  const sunDate = { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
  const SUN_DATES = [
    ["Today", null], ["Mar 21", [3, 21]], ["Jun 21", [6, 21]], ["Sep 23", [9, 23]], ["Dec 21", [12, 21]],
  ];
  let activeDate = "Today";
  function renderDates() {
    $("sun-dates").replaceChildren(...SUN_DATES.map(([label, md]) => chip(label, label === activeDate, () => {
      activeDate = label;
      [sunDate.m, sunDate.d] = md || [now.getMonth() + 1, now.getDate()];
      renderDates();
      updateSun();
    })));
  }

  // Approximate solar position; returns altitude and azimuth (from north) in degrees.
  function sunPosition(date, lat, lng) {
    const rad = Math.PI / 180;
    const d = date.getTime() / 86400000 - 10957.5;
    const g = (357.529 + 0.98560028 * d) * rad;
    const q = 280.459 + 0.98564736 * d;
    const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
    const e = (23.439 - 0.00000036 * d) * rad;
    const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
    const dec = Math.asin(Math.sin(e) * Math.sin(L));
    const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
    const H = (gmst * 15 + lng) * rad - ra;
    const phi = lat * rad;
    const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
    const az = Math.atan2(-Math.sin(H) * Math.cos(dec),
      Math.sin(dec) * Math.cos(phi) - Math.cos(dec) * Math.sin(phi) * Math.cos(H));
    return { alt: alt / rad, az: (az / rad + 360) % 360 };
  }

  function updateSun() {
    const mins = Number(sunTime.value);
    const date = new Date(Date.UTC(sunDate.y, sunDate.m - 1, sunDate.d, 0, mins) - C.utcOffsetHours * 3600e3);
    viewer.clock.currentTime = Cesium.JulianDate.fromDate(date);
    const h = Math.floor(mins / 60);
    $("sun-time-label").textContent = `${((h + 11) % 12) + 1}:${pad(mins % 60)} ${h < 12 ? "am" : "pm"}`;
    const sun = sunPosition(date, D.origin.lat, D.origin.lng);
    $("sun-info").textContent = sun.alt > 0
      ? `Sun ${Math.round(sun.alt)}° high in the ${compassPoint(sun.az)} (${Math.round(sun.az)}°)`
      : "Sun is below the horizon";
  }
  sunTime.oninput = updateSun;
  $("shadows").onchange = (e) => { viewer.shadows = e.target.checked; };

  let playTimer = null;
  $("sun-play").onclick = () => {
    if (playTimer) {
      clearInterval(playTimer);
      playTimer = null;
      $("sun-play").textContent = "▶";
      return;
    }
    $("sun-play").textContent = "❚❚";
    playTimer = setInterval(() => {
      let v = Number(sunTime.value) + 5;
      if (v > Number(sunTime.max)) v = Number(sunTime.min);
      sunTime.value = v;
      updateSun();
    }, 60);
  };

  // ---------------------------------------------------------------- real city view
  let realCity = false;
  let googleTiles = null;
  let realGround = C.groundHeight;

  // Points `dist` metres outside the site boundary, along each vertex's outward normal.
  function ringOutside(dist) {
    const p = D.site;
    let area = 0;
    for (let i = 0; i < p.length; i++) {
      const [x1, y1] = p[i];
      const [x2, y2] = p[(i + 1) % p.length];
      area += x1 * y2 - x2 * y1;
    }
    return p.map((cur, i) => {
      const prev = p[(i - 1 + p.length) % p.length];
      const next = p[(i + 1) % p.length];
      const len = Math.hypot(next[0] - prev[0], next[1] - prev[1]) || 1;
      const tx = (next[0] - prev[0]) / len;
      const ty = (next[1] - prev[1]) / len;
      const [nx, ny] = area > 0 ? [ty, -tx] : [-ty, tx];
      return [cur[0] + nx * dist, cur[1] + ny * dist];
    });
  }

  async function sampleGround() {
    // Ten points just outside the boundary; a low percentile keeps roofs and trees from lifting the ground.
    const ring = ringOutside(20).filter((_, i, all) => i % Math.ceil(all.length / 10) === 0)
      .map(([e, n]) => Cesium.Cartographic.fromCartesian(toWorld(e, n)));
    const exclude = [unitPrimitive, ...otherPrimitives];
    const pick = (heights) => {
      const hs = heights.filter(Number.isFinite).sort((a, b) => a - b);
      return hs.length ? hs[Math.floor(hs.length * 0.2)] : null;
    };
    const detailed = scene.sampleHeightMostDetailed(ring.map((c) => c.clone()), exclude)
      .then((res) => pick(res.map((c) => c.height)));
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 10000));
    const h = await Promise.race([detailed, timeout]);
    if (h !== null) return h;
    // Fall back to whatever tiles have loaded so far; null means "try again next time".
    return pick(ring.map((c) => scene.sampleHeight(c, exclude)));
  }

  function clipSite() {
    // Cut whatever currently stands on the site out of the photorealistic tiles.
    googleTiles.clippingPolygons = new Cesium.ClippingPolygonCollection({
      polygons: [new Cesium.ClippingPolygon({ positions: D.site.map(([e, n]) => toWorld(e, n)) })],
    });
  }

  async function setRealCity(on) {
    if (on && !C.googleMapsApiKey) {
      $("real-city").checked = false;
      flash("Add a Google Maps API key in config.js to enable the real city view.");
      return;
    }
    realCity = on;
    if (!on) {
      if (googleTiles) googleTiles.show = false;
      scene.globe.show = true;
      scene.skyAtmosphere.show = false;
      baseHeight = 0;
      buildScene();
      return;
    }
    status("Loading real city view…");
    try {
      if (!googleTiles) {
        googleTiles = await Cesium.createGooglePhotorealistic3DTileset(
          { key: C.googleMapsApiKey, onlyUsingWithGoogleGeocoder: true },
          { showCreditsOnScreen: true, shadows: Cesium.ShadowMode.ENABLED });
        scene.primitives.add(googleTiles);
      }
      googleTiles.show = true;
      scene.globe.show = false;
      scene.skyAtmosphere.show = true;
      // Ground height and site clipping only refine the view; a failure here shouldn't turn it off.
      if (realGround === null || realGround === undefined) {
        try {
          realGround = await sampleGround();
        } catch (e) {
          console.warn("Could not sample the ground height", e);
        }
      }
      if (!googleTiles.clippingPolygons) {
        try {
          clipSite();
        } catch (e) {
          console.warn("Could not cut the site out of the city tiles", e);
        }
      }
      if (!realCity) return; // toggled off while loading
      baseHeight = realGround ?? 0;
      buildScene();
      status(null);
    } catch (err) {
      console.error(err);
      realCity = false;
      $("real-city").checked = false;
      if (googleTiles) googleTiles.show = false;
      scene.globe.show = true;
      scene.skyAtmosphere.show = false;
      status(null);
      flash(cityViewError(err), 12000);
    }
  }

  // Say why the city tiles failed, so the cause is visible without opening the browser console.
  function cityViewError(err) {
    const code = err && err.statusCode;
    if (location.protocol === "file:") {
      return "The real city view only works when the site is opened from its web address, not as a file.";
    }
    if (code === 403) {
      return `Google refused the real city view for ${location.origin} (error 403). Check that the key's ` +
        "website restrictions include this address and that the Map Tiles API is allowed.";
    }
    if (code === 400) return "Google didn't accept the API key (error 400). Check the key in config.js.";
    if (code === 429) return "The real city view has hit Google's usage limit (error 429). Please try again later.";
    return `Couldn't reach Google's 3D city tiles${code ? ` (error ${code})` : ""}. ` +
      "Check your internet connection and try again.";
  }
  $("real-city").onchange = (e) => setRealCity(e.target.checked);

  // ---------------------------------------------------------------- messages
  function status(text) {
    $("status").hidden = !text;
    $("status").textContent = text || "";
  }
  let flashTimer = null;
  function flash(text, ms = 4500) {
    status(text);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => status(null), ms);
  }

  function whatsappLink(text) {
    const n = (C.whatsappNumber || "").replace(/\D/g, "");
    return n ? `https://wa.me/${n}?text=${encodeURIComponent(text)}` : "#register";
  }

  // ---------------------------------------------------------------- content sections
  // e.g. "Blk 1 #03-07 to #21-07, Blk 3 #03-17 to #21-17"
  function describeStacks(code) {
    const groups = new Map();
    units.filter((u) => baseType(u.code) === code).forEach((u) => {
      const key = u.stack;
      const g = groups.get(key) || { u, min: u.level, max: u.level };
      g.min = Math.min(g.min, u.level);
      g.max = Math.max(g.max, u.level);
      groups.set(key, g);
    });
    return [...groups.values()].map(({ u, min, max }) =>
      `${u.block.name} #${pad(min)}-${u.stack} to #${pad(max)}-${u.stack}`).join(", ");
  }

  function renderContent() {
    document.title = `${C.projectName} · 3D Explorer`;
    $("brand").textContent = C.projectName;
    $("tagline").textContent = C.tagline;

    $("stats").innerHTML = [
      [units.length.toLocaleString(), "homes"],
      [blocks.length, "towers"],
      [Math.max(...blocks.map((b) => b.last)), "storeys (Luxury towers)"],
      ["5 ha", "site"],
      ["80+", "facilities"],
    ].map(([n, l]) => `<div><strong>${n}</strong><span>${l}</span></div>`).join("");

    $("mix-body").replaceChildren(...D.categories.map((c) => {
      const list = units.filter((u) => u.category === c);
      const sqft = [...new Set(list.map((u) => u.type.sqft))].sort((a, b) => a - b);
      const sqm = [...new Set(list.map((u) => u.type.sqm))].sort((a, b) => a - b);
      const tr = document.createElement("tr");
      tr.innerHTML = `<td><span class="dot" style="background:${c.color}"></span>${c.label}</td>
        <td>${sqm.join(" & ")} sqm · ${sqft.map((s) => s.toLocaleString()).join(" & ")} sqft</td>
        <td>${list.length}</td><td>${Math.round((list.length / units.length) * 100)}%</td>`;
      const td = document.createElement("td");
      const b = document.createElement("button");
      b.className = "btn btn-ghost btn-sm";
      b.textContent = "Show in 3D";
      b.onclick = () => { setFilter({ category: c.id }); location.hash = "#explorer"; };
      td.appendChild(b);
      tr.appendChild(td);
      return tr;
    }));
    $("mix-foot").innerHTML =
      `<tr><td>Total</td><td></td><td>${units.length.toLocaleString()}</td><td>100%</td><td></td></tr>`;

    $("addresses").innerHTML = blocks.map((b) =>
      `<li><strong>${b.name}</strong> (${b.collection}) — ${b.address}</li>`).join("");
    $("maps-link").href = `https://www.google.com/maps/search/?api=1&query=${D.origin.lat},${D.origin.lng}`;

    // Floor plans, one card per unit type, grouped by collection.
    const codes = Object.keys(D.types).filter((c) => baseType(c) === c);
    let tab = "Classic";
    const renderPlans = () => {
      $("plan-tabs").replaceChildren(...["Classic", "Luxury"].map((t) =>
        chip(`${t} Collection`, t === tab, () => { tab = t; renderPlans(); })));
      $("plans").replaceChildren(...codes.filter((c) => c.endsWith("(L)") === (tab === "Luxury")).map((code) => {
        const t = D.types[code];
        const cat = categories.get(t.category);
        const count = units.filter((u) => baseType(u.code) === code).length;
        const a = document.createElement("article");
        a.innerHTML = `<a target="_blank" rel="noopener"><img loading="lazy"></a>
          <h3><span class="dot" style="background:${cat.color}"></span><span class="code"></span></h3>
          <p class="plan-cat"></p><p class="plan-stacks"></p>`;
        a.querySelector("a").href = t.plan;
        a.querySelector("img").src = t.plan;
        a.querySelector("img").alt = `Floor plan, type ${code}`;
        a.querySelector(".code").textContent = `Type ${code}`;
        a.querySelector(".plan-cat").textContent =
          `${cat.label} · ${t.sqm} sqm (${t.sqft.toLocaleString()} sqft) · ${count} units`;
        a.querySelector(".plan-stacks").textContent = describeStacks(code);
        const b = document.createElement("button");
        b.className = "btn btn-ghost btn-sm";
        b.textContent = "Show in 3D";
        b.onclick = () => { setFilter({ type: code }); location.hash = "#explorer"; };
        a.appendChild(b);
        return a;
      }));
    };
    renderPlans();

    $("wa-float").hidden = !C.whatsappNumber;
    $("wa-float").href = whatsappLink(`Hi, I'm interested in ${C.projectName}.`);

    $("register-form").onsubmit = (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const text = `Register interest — ${C.projectName}\n` +
        ["name", "phone", "email", "unit", "message"]
          .filter((k) => f.get(k))
          .map((k) => `${k[0].toUpperCase() + k.slice(1)}: ${f.get(k)}`).join("\n");
      if (C.whatsappNumber) {
        window.open(whatsappLink(text), "_blank", "noopener");
      } else if (C.contactEmail) {
        location.href = `mailto:${C.contactEmail}?subject=${encodeURIComponent(
          `${C.projectName} enquiry`)}&body=${encodeURIComponent(text)}`;
      } else {
        alert("Thanks! (Set whatsappNumber or contactEmail in config.js to receive enquiries.)");
      }
    };
  }

  // ---------------------------------------------------------------- start
  if (window.matchMedia("(max-width: 760px)").matches) $("legend-box").open = false;
  buildScene();
  renderFilters();
  fillBlocks();
  fillLevels();
  fillUnits();
  renderDates();
  updateSun();
  renderContent();
  flyOverview(viewHeading, 0);

  // Exposed for debugging in the browser console.
  window.explorer = { viewer, units, selectUnit, setRealCity, setFilter };
})();
