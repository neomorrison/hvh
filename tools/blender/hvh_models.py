"""hvh model builder — run inside Blender (headless: blender -b --factory-startup --python-expr "...").
Builds a rigged operator-style player (aim pose: both hands on the gun), nine weapons and four grenades,
and exports them to <app>/models/*.glb using the exact node/clip names src/models.js expects.
Units: 1 Blender unit = 1 source unit (player ~78u).  Blender is Z-up, -Y forward; glTF export (Y-up)
turns that into the game's +Z forward.

  import sys; sys.path.insert(0, r"D:/programming/hvh/app/tools/blender")
  import hvh_models, importlib; importlib.reload(hvh_models); hvh_models.build_all(r"D:/programming/hvh/app/models")
"""
import bpy, bmesh, math, os
from mathutils import Vector, Euler

# ----------------------------------------------------------------------------- helpers
def clear_scene():
    bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
    for c in (bpy.data.meshes, bpy.data.materials, bpy.data.armatures, bpy.data.actions):
        for d in list(c):
            if d.users == 0: c.remove(d)

def mat(name, rgb, rough=0.8, metal=0.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True; bsdf = m.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*rgb, 1); bsdf.inputs['Roughness'].default_value = rough; bsdf.inputs['Metallic'].default_value = metal
    m.diffuse_color = (*rgb, 1)
    return m

def box(name, size, loc, m, rot=(0, 0, 0), bevel=0.0, smooth=False):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.active_object; o.name = name; o.scale = (size[0], size[1], size[2]); bpy.ops.object.transform_apply(scale=True)
    if m: o.data.materials.append(m)
    if bevel > 0:
        b = o.modifiers.new('bevel', 'BEVEL'); b.width = min(bevel, min(size) * 0.45); b.segments = 2
        bpy.ops.object.modifier_apply(modifier=b.name)
    if smooth: bpy.ops.object.shade_smooth()
    return o

def cyl(name, r, length, loc, m, axis='Z', segs=16, rot=(0, 0, 0)):
    rot = {'Z': rot, 'X': (0, math.pi / 2, 0), 'Y': (math.pi / 2, 0, 0)}[axis] if rot == (0, 0, 0) else rot
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=length, location=loc, rotation=rot, vertices=segs)
    o = bpy.context.active_object; o.name = name
    if m: o.data.materials.append(m)
    bpy.ops.object.shade_smooth(); return o

def sphere(name, r, loc, m, segs=16):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=loc, segments=segs, ring_count=max(6, segs // 2))
    o = bpy.context.active_object; o.name = name
    if m: o.data.materials.append(m)
    bpy.ops.object.shade_smooth(); return o

def join(objs, name):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]; bpy.ops.object.join()
    j = bpy.context.active_object; j.name = name; j.data.name = name
    bpy.ops.object.select_all(action='DESELECT'); return j

def parent_to(child, parent):
    child.parent = parent; child.matrix_parent_inverse = parent.matrix_world.inverted()

def export_glb(path, objs, animations=False):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
        for ch in o.children_recursive: ch.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    kw = dict(filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
              export_animations=animations, export_skins=animations, export_materials='EXPORT')
    if animations: kw.update(export_nla_strips=True, export_frame_range=False, export_force_sampling=True, export_anim_single_armature=False)
    bpy.ops.export_scene.gltf(**kw)
    return path

# ----------------------------------------------------------------------------- player
# REST POSE = AIM POSE.  Both hands sit where the gun's grip and foregrip are, in chest space, so the
# weapon can hang off the Chest bone at a fixed offset and the arms are ALWAYS on it — and pitching the
# gun means pitching the two upper arms by the same angle about the shoulder line (see models.js).
SHOULDER_Z = 61
GRIP = (4, -22, 52)          # right hand / gun grip origin   (x right, -y forward, z up)
FOREGRIP = (-3, -38, 54)     # left hand
BONES = [  # name, head, tail, parent
    ('Hips',       (0, 0, 40),   (0, 0, 46),   None),
    ('Spine',      (0, 0, 46),   (0, 0, 56),   'Hips'),
    ('Chest',      (0, 0, 56),   (0, 0, 64),   'Spine'),
    ('Neck',       (0, 0, 64),   (0, 0, 68),   'Chest'),
    ('Head',       (0, 0, 68),   (0, 0, 79),   'Neck'),
    ('UpperArm.R', (12.5, 0, SHOULDER_Z), (14, -8, 48), 'Chest'),
    ('Forearm.R',  (14, -8, 48), GRIP, 'UpperArm.R'),
    ('Hand.R',     GRIP, (2, -28, 52), 'Forearm.R'),
    ('UpperArm.L', (-12.5, 0, SHOULDER_Z), (-13, -15, 49), 'Chest'),
    ('Forearm.L',  (-13, -15, 49), FOREGRIP, 'UpperArm.L'),
    ('Hand.L',     FOREGRIP, (-2, -44, 54), 'Forearm.L'),
    ('Thigh.L',    (-5.5, 0, 40), (-5.5, 0, 20), 'Hips'),
    ('Shin.L',     (-5.5, 0, 20), (-5.5, 0, 4),  'Thigh.L'),
    ('Foot.L',     (-5.5, 0, 4),  (-5.5, -8, 1), 'Shin.L'),
    ('Thigh.R',    (5.5, 0, 40),  (5.5, 0, 20),  'Hips'),
    ('Shin.R',     (5.5, 0, 20),  (5.5, 0, 4),   'Thigh.R'),
    ('Foot.R',     (5.5, 0, 4),   (5.5, -8, 1),  'Shin.R'),
]
# Body = a vertex skeleton with per-joint radii run through the Skin modifier (one continuous quad mesh,
# nothing to pinch) and ONE subdivision level, so it reads as a person without going balloon-smooth;
# the military look comes from rigid gear parts welded on afterwards (helmet, plates, pads, boots).
SKIN_V = [
    ('pelvis', (0, 0, 39), (9.0, 5.8)), ('belly', (0, 0, 46), (8.8, 5.8)), ('chest', (0, 0, 55), (12.0, 7.0)), ('shoulders', (0, 0, 61), (14.0, 6.5)),
    ('neck', (0, 0, 65.5), (3.4, 3.4)), ('chin', (0, 0, 68), (4.8, 5.2)), ('head', (0, 0, 72.5), (6.3, 6.7)), ('crown', (0, 0, 77.5), (4.2, 4.6)),
    ('shoulder.R', (12.5, 0, SHOULDER_Z), (3.8, 3.8)), ('elbow.R', (14, -8, 48), (3.0, 3.0)), ('wrist.R', (GRIP[0] + 1, GRIP[1] + 2, GRIP[2]), (2.4, 2.4)), ('hand.R', (2, -27, 52), (2.8, 2.2)),
    ('shoulder.L', (-12.5, 0, SHOULDER_Z), (3.8, 3.8)), ('elbow.L', (-13, -15, 49), (3.0, 3.0)), ('wrist.L', (FOREGRIP[0], FOREGRIP[1] + 2, FOREGRIP[2]), (2.4, 2.4)), ('hand.L', (-2, -43, 54), (2.8, 2.2)),
]
for _sx, _t in ((-1, 'L'), (1, 'R')):
    SKIN_V += [('hip.' + _t, (_sx * 5.5, 0, 38), (4.6, 4.6)), ('knee.' + _t, (_sx * 5.5, 0, 20), (3.7, 3.7)), ('ankle.' + _t, (_sx * 5.5, 0, 4), (3.0, 3.0)), ('toe.' + _t, (_sx * 5.5, -8, 1.6), (3.0, 1.6))]
SKIN_E = [('pelvis', 'belly'), ('belly', 'chest'), ('chest', 'shoulders'), ('shoulders', 'neck'), ('neck', 'chin'), ('chin', 'head'), ('head', 'crown')]
for _t in ('L', 'R'):
    SKIN_E += [('shoulders', 'shoulder.' + _t), ('shoulder.' + _t, 'elbow.' + _t), ('elbow.' + _t, 'wrist.' + _t), ('wrist.' + _t, 'hand.' + _t),
               ('pelvis', 'hip.' + _t), ('hip.' + _t, 'knee.' + _t), ('knee.' + _t, 'ankle.' + _t), ('ankle.' + _t, 'toe.' + _t)]

def _region_material(c):
    """material slot for a face centre: 0 skin, 1 cloth, 2 pants, 3 vest, 4 boot, 5 visor"""
    x, y, z = c
    if z >= 74.5: return 3                        # helmet shell
    if 68 <= z < 74.5 and y < -3: return 5        # visor
    if z >= 64: return 0                          # head / neck
    if abs(x) > 10.5 or y < -6:                   # arms (in front of the chest in the aim pose)
        return 1 if z > 45 and y > -20 else 0     # sleeve / forearm+hand
    if z >= 41: return 1                          # shirt (the plate is a separate part)
    return 4 if z < 5.5 else 2                    # boots / trousers

# rigid gear: (name, size, loc, material key, bone, bevel)
GEAR = [
    ('helmet', (15.5, 16.5, 9), (0, 0.8, 76), 'vest', 'Head', 2.5),      # wraps the top half of the head (head equator at 72.5)
    ('plate_f', (19, 3.5, 15), (0, -7.2, 54), 'vest', 'Chest', 1.0),
    ('plate_b', (19, 3, 15), (0, 6.8, 54), 'vest', 'Chest', 1.0),
    ('pouch_l', (5, 3, 6), (-6.5, -7.8, 46), 'boot', 'Chest', 0.6),
    ('pouch_r', (5, 3, 6), (6.5, -7.8, 46), 'boot', 'Chest', 0.6),
    ('belt', (19.5, 12.5, 2.6), (0, 0, 41.5), 'boot', 'Hips', 0.5),
    ('pad_l', (6, 8, 4), (-14.2, 0, 63.5), 'vest', 'Chest', 1.0),
    ('pad_r', (6, 8, 4), (14.2, 0, 63.5), 'vest', 'Chest', 1.0),
    ('knee_l', (7.6, 4.5, 6.5), (-5.5, -2.6, 19), 'boot', 'Shin.L', 1.2),   # sunk into the shin (radius 3.7), not floating in front of it
    ('knee_r', (7.6, 4.5, 6.5), (5.5, -2.6, 19), 'boot', 'Shin.R', 1.2),
    ('boot_l', (8, 13, 5), (-5.5, -2, 2.5), 'boot', 'Foot.L', 1.0),
    ('boot_r', (8, 13, 5), (5.5, -2, 2.5), 'boot', 'Foot.R', 1.0),
]

def build_player():
    mats = dict(skin=mat('skin', (0.85, 0.65, 0.5)), cloth=mat('cloth', (0.18, 0.31, 0.53)), pants=mat('pants', (0.13, 0.19, 0.28)),
                vest=mat('vest', (0.12, 0.16, 0.24), 0.6, 0.15), boot=mat('boot', (0.08, 0.09, 0.11)), visor=mat('visor', (0.07, 0.08, 0.09), 0.35))
    idx = {n: i for i, (n, _, _) in enumerate(SKIN_V)}
    me = bpy.data.meshes.new('Player'); me.from_pydata([v[1] for v in SKIN_V], [(idx[a], idx[b]) for a, b in SKIN_E], [])
    body = bpy.data.objects.new('Player', me); bpy.context.collection.objects.link(body)
    bpy.ops.object.select_all(action='DESELECT'); body.select_set(True); bpy.context.view_layer.objects.active = body
    bpy.ops.object.modifier_add(type='SKIN'); sk = body.modifiers[-1]; sk.use_smooth_shade = True
    for i, (n, _, r) in enumerate(SKIN_V):
        sv = me.skin_vertices[0].data[i]; sv.radius = r; sv.use_root = (n == 'pelvis')
    bpy.ops.object.modifier_apply(modifier=sk.name)
    for k in ('skin', 'cloth', 'pants', 'vest', 'boot', 'visor'): me.materials.append(mats[k])
    for p in me.polygons: p.material_index = _region_material(p.center)
    bpy.ops.object.modifier_add(type='SUBSURF'); sub = body.modifiers[-1]; sub.levels = 1; sub.render_levels = 1
    bpy.ops.object.modifier_apply(modifier=sub.name)
    bpy.ops.object.shade_smooth()
    # armature
    bpy.ops.object.armature_add(enter_editmode=True, location=(0, 0, 0)); arm = bpy.context.active_object; arm.name = 'Armature'
    eb = arm.data.edit_bones; eb.remove(eb[0]); made = {}
    for n, h, t, p in BONES:
        b = eb.new(n); b.head, b.tail = Vector(h), Vector(t)
        if p: b.parent = made[p]; b.use_connect = False
        made[n] = b
    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.select_all(action='DESELECT'); body.select_set(True); arm.select_set(True); bpy.context.view_layer.objects.active = arm
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')
    # rigid gear: each part fully weighted to one bone, then welded into the body mesh (one SkinnedMesh)
    parts = []
    for name, size, loc, mk, bone, bev in GEAR:
        o = box(name, size, loc, mats[mk], bevel=bev)
        vg = o.vertex_groups.new(name=bone); vg.add(list(range(len(o.data.vertices))), 1.0, 'REPLACE')
        parts.append(o)
    bpy.ops.object.select_all(action='DESELECT')
    for o in parts: o.select_set(True)
    body.select_set(True); bpy.context.view_layer.objects.active = body; bpy.ops.object.join()
    bpy.ops.object.select_all(action='DESELECT')
    build_player_anims(arm)
    return arm, body

def _key(pb, frame, rot=None):
    if rot is not None: pb.rotation_mode = 'XYZ'; pb.rotation_euler = Euler([math.radians(a) for a in rot]); pb.keyframe_insert('rotation_euler', frame=frame)

def _clip(arm, name, frames, pose):
    """pose(f) -> {bone: (rx,ry,rz deg)} ; cyclic action of `frames` length stored as an NLA strip."""
    act = bpy.data.actions.new(name); arm.animation_data_create(); arm.animation_data.action = act
    names = [b[0] for b in BONES]; feet = [arm.pose.bones[n] for n in ('Foot.L', 'Foot.R')]; hips = arm.pose.bones['Hips']
    for f in range(0, frames + 1):
        p = pose(f / frames)
        for bn in names:                     # key EVERY bone so earlier clips on the NLA stack can't bleed through
            _key(arm.pose.bones[bn], f, p.get(bn, (0, 0, 0)))
        # ground the feet: drop the hips so the lowest foot point sits on z=0 (crouch folds the legs, walk/run swing them)
        bpy.context.scene.frame_set(f)
        minz = min((arm.matrix_world @ q).z for pb in feet for q in (pb.head, pb.tail))
        hips.location.y -= minz; hips.keyframe_insert('location', frame=f)     # Hips bone is vertical: local Y = world up
    # Blender 4.4+/5.x layered actions: fcurves live in layer -> strip -> channelbag (keyframe_insert created them)
    fcurves = [fc for L in act.layers for S in L.strips for cb in S.channelbags for fc in cb.fcurves] if act.is_action_layered else list(act.fcurves)
    for fc in fcurves:
        for kp in fc.keyframe_points: kp.interpolation = 'BEZIER'
        m = fc.modifiers.new('CYCLES')
    act.use_frame_range = True; act.frame_start, act.frame_end = 0, frames
    tr = arm.animation_data.nla_tracks.new(); tr.name = name; st = tr.strips.new(name, 0, act); st.name = name
    arm.animation_data.action = None
    return act

def build_player_anims(arm):
    """Arms stay in the aim pose in every clip (the gun is on the chest); legs, hips and torso move."""
    for pb in arm.pose.bones: pb.rotation_mode = 'XYZ'
    S = math.sin; P = 2 * math.pi
    def idle(t):  return {'Chest': (1.5 * S(t * P), 0, 0), 'Head': (-1.5 * S(t * P), 0, 0)}
    def walk(t):
        s = S(t * P)
        return {'Thigh.L': (30 * s, 0, 0), 'Thigh.R': (-30 * s, 0, 0), 'Shin.L': (max(0, -40 * s), 0, 0), 'Shin.R': (max(0, 40 * s), 0, 0),
                'Spine': (0, 0, 2 * s), 'Chest': (3, 0, -2 * s), 'Head': (-2, 0, 0)}
    def run(t):
        s = S(t * P)
        return {'Thigh.L': (55 * s, 0, 0), 'Thigh.R': (-55 * s, 0, 0), 'Shin.L': (max(0, -70 * s), 0, 0), 'Shin.R': (max(0, 70 * s), 0, 0),
                'Spine': (0, 0, 4 * s), 'Chest': (12, 0, -3 * s), 'Hips': (0, 0, -4 * s), 'Head': (-8, 0, 0)}
    # deep squat: thigh ~horizontal, shin leaning 35° -> hips ~19u up, head ~56u (matches the 0.72 crouch hitbox scale)
    def cidle(t): return {'Thigh.L': (-85, 0, 0), 'Thigh.R': (-85, 0, 0), 'Shin.L': (120, 0, 0), 'Shin.R': (120, 0, 0), 'Spine': (12, 0, 0), 'Chest': (6 + 1.5 * S(t * P), 0, 0), 'Head': (-14, 0, 0)}
    def cwalk(t):
        s = S(t * P); base = cidle(t)
        base.update({'Thigh.L': (-85 + 18 * s, 0, 0), 'Thigh.R': (-85 - 18 * s, 0, 0), 'Shin.L': (120 - 12 * s, 0, 0), 'Shin.R': (120 + 12 * s, 0, 0)}); return base
    _clip(arm, 'idle', 48, idle); _clip(arm, 'walk', 24, walk); _clip(arm, 'run', 16, run); _clip(arm, 'crouch_idle', 48, cidle); _clip(arm, 'crouch_walk', 28, cwalk)

# ----------------------------------------------------------------------------- weapons
# Built in GAME coordinates (x right, y up, z = barrel/forward) via B()/C(); the grip origin is (0,0,0)
# and the barrel runs +Z. Every gun is the same "held" size so the aim pose fits all of them.
def build_weapons():
    black, dark, metal, wood, tan = mat('black', (0.14, 0.15, 0.18), 0.5, 0.45), mat('dark', (0.08, 0.09, 0.11), 0.6, 0.3), mat('metal', (0.6, 0.64, 0.68), 0.3, 0.8), mat('wood', (0.42, 0.28, 0.14), 0.7), mat('tan', (0.71, 0.61, 0.43), 0.75)
    roots = []
    def B(n, s, l, m, bev=0.4): return box(n, (s[0], s[2], s[1]), (l[0], -l[2], l[1]), m, bevel=bev)   # (x, y_up, z_fwd) -> blender, size AND position
    def C(n, r, L, l, m):        return cyl(n, r, L, (l[0], -l[2], l[1]), m, axis='Y')
    def finish(name, parts):
        r = join(parts, name); r.location = (0, 0, 0)
        # join() keeps the ACTIVE part's object transform — a cylinder part carries a 90° rotation, and a
        # rifle joined onto its barrel exported with that rotation on the root node (the loader then
        # reset it and the rifle stood on end). Bake every root to identity.
        bpy.ops.object.select_all(action='DESELECT'); r.select_set(True); bpy.context.view_layer.objects.active = r
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
        roots.append(r); return r
    def sights(y, z0, z1, h=1.2): return [B('rs', (2.4, h, 1), (0, y, z0), black, 0.15), B('fs', (0.8, h + 0.4, 1), (0, y, z1), black, 0.15)]
    def pistol(name, slide_len, slide_mat, barrel_r, barrel_len, extra=None):
        p = [B('grip', (3.6, 8, 4.6), (0, -5.5, -3.5), black, 0.5), B('frame', (4.2, 2.6, slide_len - 2), (0, -1.2, slide_len / 2 - 3.5), black, 0.3),
             B('slide', (4.2, 3.4, slide_len), (0, 1.2, slide_len / 2 - 3), slide_mat, 0.6), B('guard', (3, 0.8, 5), (0, -3.6, 0.5), black, 0.15), B('trig', (0.8, 1.6, 0.6), (0, -2.6, 0.2), black, 0.1),
             C('barrel', barrel_r, barrel_len, (0, 1.2, slide_len - 3 + barrel_len / 2), metal), B('mag', (2.6, 2, 3.4), (0, -10.2, -3.4), dark, 0.2)] + sights(3.3, -2, slide_len - 4)
        if extra: p += extra()
        return finish(name, p)
    pistol('glock', 16, dark, 1.2, 1.5); pistol('usp', 16, black, 2.2, 14)
    pistol('deagle', 21, metal, 1.7, 3)
    # r8: revolver with a separate Hammer child (game rotates it on x to cock) — sits ON the frame, not behind it
    r8 = finish('r8', [B('grip', (3.8, 8, 5), (0, -5.5, -4), wood, 0.6), B('frame', (4.4, 4, 12), (0, 0.4, 2), black, 0.5), C('cyl', 3.2, 7, (0, 0.9, 1.5), metal), C('barrel', 1.5, 22, (0, 1.3, 16), metal),
                       B('rib', (1.6, 1.4, 20), (0, 3.0, 15), black, 0.2), B('guard', (3, 0.8, 5), (0, -3.2, 0.5), black, 0.15), B('trig', (0.8, 1.6, 0.6), (0, -2.2, 0.2), black, 0.1)] + sights(3.6, -2, 25))
    hb = box('Hammer', (1.6, 3.6, 1.8), (0, 4.2, 3.2 + 1.2), metal, bevel=0.3); hb.location = (0, 4.2, 4.4); parent_to(hb, r8); hb.name = 'Hammer'   # base at the frame's back top edge
    # duals: two pistols side by side
    d = []
    for sx in (-6, 6): d += [B('g' + str(sx), (3.4, 7.5, 4.4), (sx, -5.2, -3.4), black, 0.5), B('s' + str(sx), (4, 3.2, 15), (sx, 1.0, 4.5), metal, 0.6), B('f' + str(sx), (4, 2.4, 13), (sx, -1.2, 4), black, 0.3), C('b' + str(sx), 1.1, 6, (sx, 1.0, 14), metal), B('t' + str(sx), (0.8, 1.6, 0.6), (sx, -2.6, 0.2), black, 0.1)]
    finish('duals', d)
    # ssg08 bolt-action
    finish('ssg', [C('barrel', 1.3, 62, (0, 1, 22), metal), B('recv', (4.6, 5.5, 30), (0, -0.6, -2), dark, 0.8), B('mag', (4, 4, 8), (0, -4.6, -6), dark, 0.4), B('stock', (4.6, 6.5, 24), (0, -2.4, -28), tan, 1.2), B('butt', (5.4, 8, 3), (0, -3.5, -40), boot_black() if False else black, 0.5),
                   B('cheek', (4.8, 2, 10), (0, 1.5, -30), tan, 0.6), C('scope', 2.4, 20, (0, 6.4, -2), dark), C('scope_f', 3.0, 5, (0, 6.4, 9), dark), C('scope_r', 2.9, 4, (0, 6.4, -12), dark),
                   B('ring1', (3.4, 3, 2.2), (0, 4, -6), metal, 0.2), B('ring2', (3.4, 3, 2.2), (0, 4, 4), metal, 0.2), B('bolt', (5.5, 1.4, 2.6), (3.2, 1.2, -8), metal, 0.3), B('guard', (3, 0.8, 6), (0, -3.6, -9), black, 0.15)])
    for key, stockm in (('scar', tan), ('g3', black)):
        finish(key, [C('barrel', 1.6, 50, (0, 2, 26), metal), B('recv', (6, 8.5, 40), (0, 0, 2), dark, 1.0), B('hguard', (6.5, 6, 20), (0, 1.5, 22), stockm if key == 'scar' else dark, 0.8),
                     B('mag', (5, 14, 8), (0, -12, -4), black, 0.6), B('grip', (4, 9, 6), (0, -9.5, -14), black, 0.8), B('stock', (5, 8, 24), (0, -1.5, -34), stockm, 1.2), B('butt', (6, 10, 3), (0, -2.5, -46), black, 0.5),
                     C('scope', 3, 24, (0, 9, 2), dark), C('scope_f', 3.6, 5, (0, 9, 15), dark), C('scope_r', 3.4, 4, (0, 9, -11), dark), B('ring1', (4.4, 4, 2.4), (0, 6, -6), metal, 0.2), B('ring2', (4.4, 4, 2.4), (0, 6, 10), metal, 0.2),
                     B('rail', (3, 1.5, 30), (0, 4.6, 2), dark, 0.2), B('guard', (3.2, 0.8, 6), (0, -5.2, -10), black, 0.15), B('trig', (0.8, 1.6, 0.6), (0, -4.2, -10.5), black, 0.1), B('muzzle', (2.6, 2.6, 5), (0, 2, 50), black, 0.4)])
    # knife: tapered blade (a scaled wedge), guard, ribbed handle
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0.15, -10.5, 0.8)); kb = bpy.context.active_object; kb.name = 'blade'; kb.scale = (0.5, 15, 3.2); bpy.ops.object.transform_apply(scale=True)
    kb.data.materials.append(metal)
    bm = bmesh.new(); bm.from_mesh(kb.data)
    for v in bm.verts:
        if v.co.y < -14: v.co.z = 0.8 + (v.co.z - 0.8) * 0.15; v.co.x *= 0.4     # tip
        elif v.co.y < -6: v.co.z = 0.8 + (v.co.z - 0.8) * (1.0 if v.co.z > 0.8 else 0.75)
    bm.to_mesh(kb.data); bm.free()
    finish('knife', [B('handle', (2.6, 3.2, 9), (0, -3.2, -2), dark, 0.7), B('rib1', (2.8, 3.4, 0.8), (0, -3.2, -4.5), black, 0.2), B('rib2', (2.8, 3.4, 0.8), (0, -3.2, -1.5), black, 0.2), B('guard', (1.2, 5, 1.4), (0, -1.6, 2.8), black, 0.3), kb, B('pommel', (2.8, 3.4, 1.2), (0, -3.2, -6.8), black, 0.3)])
    return roots

def boot_black(): return mat('boot', (0.08, 0.09, 0.11))

# ----------------------------------------------------------------------------- grenades
def build_nades():
    roots = []
    he = join([sphere('body', 5, (0, 0, 0), mat('nade_he', (0.25, 0.35, 0.18), 0.7, 0.2), 16), box('lever', (1.2, 7, 2), (2.5, 0, 4.5), mat('nade_lever', (0.5, 0.5, 0.52), 0.4, 0.7), bevel=0.2), cyl('fuse', 1.6, 2, (0, 0, 5.5), mat('nade_lever', (0.5, 0.5, 0.52)), axis='Z')], 'he'); he.scale = (1, 1, 1.25); roots.append(he)
    roots.append(join([cyl('can', 3.3, 11, (0, 0, 0), mat('nade_flash', (0.72, 0.74, 0.76), 0.5, 0.4)), cyl('cap', 2.4, 1.5, (0, 0, 6), mat('nade_lever', (0.5, 0.5, 0.52)))], 'flash'))
    roots.append(join([cyl('can', 3.8, 10, (0, 0, 0), mat('nade_smoke', (0.36, 0.39, 0.31), 0.7, 0.2)), cyl('cap', 2.6, 1.5, (0, 0, 5.6), mat('nade_lever', (0.5, 0.5, 0.52))), cyl('band', 4.0, 1.4, (0, 0, 0), mat('nade_band', (0.85, 0.85, 0.3), 0.6))], 'smoke'))
    bpy.ops.mesh.primitive_cylinder_add(radius=3.6, depth=9, location=(0, 0, -1.5), vertices=14); bot = bpy.context.active_object; bot.name = 'bottle'; bot.data.materials.append(mat('nade_molly', (0.48, 0.29, 0.13), 0.35, 0.05)); bpy.ops.object.shade_smooth()
    roots.append(join([bot, cyl('neck', 1.6, 5, (0, 0, 5.5), mat('nade_molly', (0.48, 0.29, 0.13))), cyl('rag', 1.9, 2, (0, 0, 8.5), mat('nade_rag', (0.85, 0.82, 0.7), 0.9))], 'molly'))
    return roots

# ----------------------------------------------------------------------------- driver
def build_all(out_dir):
    out = {}
    clear_scene(); arm, body = build_player(); out['player'] = export_glb(os.path.join(out_dir, 'player.glb'), [arm], animations=True)
    clear_scene(); out['weapons'] = export_glb(os.path.join(out_dir, 'weapons.glb'), build_weapons())
    clear_scene(); out['nades'] = export_glb(os.path.join(out_dir, 'nades.glb'), build_nades())
    return {k: (v, os.path.getsize(v)) for k, v in out.items()}
