"""hvh model builder — run inside Blender (via the MCP execute_blender_code or Text Editor).
Builds a stylised low-poly, SMOOTH (subdivided) rigged player with idle/walk/run/crouch clips,
nine weapon models and four grenade models, and exports them to <app>/models/*.glb using the
exact node/clip names src/models.js expects.  Units: 1 Blender unit = 1 source unit (player ~78u).

  import importlib, sys; sys.path.insert(0, r"D:/programming/hvh/app/tools/blender")
  import hvh_models; importlib.reload(hvh_models); hvh_models.build_all(r"D:/programming/hvh/app/models")
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
    return m

def box(name, size, loc, m, rot=(0, 0, 0), bevel=0.0, smooth=False):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.active_object; o.name = name; o.scale = (size[0], size[1], size[2]); bpy.ops.object.transform_apply(scale=True)
    if m: o.data.materials.append(m)
    if bevel > 0: b = o.modifiers.new('bevel', 'BEVEL'); b.width = bevel; b.segments = 2
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

# Blender is Z-up; the game (glTF) is Y-up. Build everything in Blender's frame with Z = game Y,
# and glTF export (export_yup=True) converts. Game +Z (forward/barrel) = Blender -Y.

# ----------------------------------------------------------------------------- player
BONES = [  # name, head(x,y,z), tail, parent   (Blender Z-up, x right, -y forward)
    ('Hips',       (0, 0, 40),   (0, 0, 46),   None),
    ('Spine',      (0, 0, 46),   (0, 0, 56),   'Hips'),
    ('Chest',      (0, 0, 56),   (0, 0, 64),   'Spine'),
    ('Neck',       (0, 0, 64),   (0, 0, 68),   'Chest'),
    ('Head',       (0, 0, 68),   (0, 0, 79),   'Neck'),
    ('UpperArm.L', (-13, 0, 62), (-15, 0, 49), 'Chest'),
    ('Forearm.L',  (-15, 0, 49), (-15, -2, 37), 'UpperArm.L'),
    ('Hand.L',     (-15, -2, 37), (-15, -4, 31), 'Forearm.L'),
    ('UpperArm.R', (13, 0, 62),  (15, 0, 49),  'Chest'),
    ('Forearm.R',  (15, 0, 49),  (14, -4, 40), 'UpperArm.R'),
    ('Hand.R',     (14, -4, 40), (12, -10, 40), 'Forearm.R'),
    ('Thigh.L',    (-5.5, 0, 40), (-5.5, 0, 20), 'Hips'),
    ('Shin.L',     (-5.5, 0, 20), (-5.5, 0, 4),  'Thigh.L'),
    ('Foot.L',     (-5.5, 0, 4),  (-5.5, -8, 1), 'Shin.L'),
    ('Thigh.R',    (5.5, 0, 40),  (5.5, 0, 20),  'Hips'),
    ('Shin.R',     (5.5, 0, 20),  (5.5, 0, 4),   'Thigh.R'),
    ('Foot.R',     (5.5, 0, 4),   (5.5, -8, 1),  'Shin.R'),
]

def build_player():
    skin, cloth, pants, vest, boot = mat('skin', (0.85, 0.65, 0.5)), mat('cloth', (0.18, 0.31, 0.53)), mat('pants', (0.13, 0.19, 0.28)), mat('vest', (0.12, 0.16, 0.24), 0.6, 0.15), mat('boot', (0.08, 0.09, 0.11))
    parts = []
    # torso built as one tapered, subdivided body so the waist twist reads as a lean, not a cut
    parts.append(box('belly', (20, 12, 12), (0, 0, 43), cloth, bevel=2.5))
    parts.append(box('chest', (24, 13, 16), (0, 0, 55), cloth, bevel=3))
    parts.append(box('vest',  (25, 14, 17), (0, 0.3, 55), vest, bevel=3))
    parts.append(cyl('neck', 3.5, 5, (0, 0, 65), skin))
    parts.append(sphere('head', 6.4, (0, 0, 72.5), skin, 20)); parts[-1].scale = (1, 1, 1.1)
    parts.append(box('helmet', (13.5, 13.5, 6), (0, 0, 76.5), vest, bevel=2))
    parts.append(box('visor', (9, 2, 4), (0, -6.4, 72), mat('visor', (0.07, 0.08, 0.09), 0.4), bevel=0.5))
    for sx, tag in ((-1, 'L'), (1, 'R')):
        parts.append(cyl('shoulder' + tag, 3.8, 7, (sx * 14, 0, 58), cloth))
        parts.append(cyl('uarm' + tag, 3, 14, (sx * 15, 0, 49), cloth))
        parts.append(cyl('farm' + tag, 2.6, 12, (sx * 15, -2, 38), skin))
        parts.append(sphere('hand' + tag, 2.8, (sx * 14.5, -4, 31.5), skin, 10))
        parts.append(cyl('thigh' + tag, 4.2, 20, (sx * 5.5, 0, 30), pants))
        parts.append(cyl('shin' + tag, 3.6, 18, (sx * 5.5, 0.5, 12), pants))
        parts.append(box('boot' + tag, (8, 13, 5), (sx * 5.5, -2, 2.5), boot, bevel=1))
    body = join(parts, 'Player')
    for m in (skin, cloth, pants, vest, boot): pass
    # smooth: shade smooth + a light subdivision so silhouettes are round under any anti-aim twist
    bpy.context.view_layer.objects.active = body; body.select_set(True)
    bpy.ops.object.shade_smooth(); sub = body.modifiers.new('sub', 'SUBSURF'); sub.levels = 1; sub.render_levels = 1
    bpy.ops.object.modifier_apply(modifier='sub')
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
    build_player_anims(arm)
    return arm, body

def _key(pb, frame, rot=None):
    if rot is not None: pb.rotation_mode = 'XYZ'; pb.rotation_euler = Euler([math.radians(a) for a in rot]); pb.keyframe_insert('rotation_euler', frame=frame)

def _clip(arm, name, frames, pose):
    """pose(f) -> {bone: (rx,ry,rz deg)} ; cyclic action of `frames` length stored as an NLA strip."""
    act = bpy.data.actions.new(name); arm.animation_data_create(); arm.animation_data.action = act
    for f in range(0, frames + 1):
        for bn, r in pose(f / frames).items():
            _key(arm.pose.bones[bn], f, r)
    for fc in act.fcurves:
        for kp in fc.keyframe_points: kp.interpolation = 'BEZIER'
        m = fc.modifiers.new('CYCLES')
    act.use_frame_range = True; act.frame_start, act.frame_end = 0, frames
    tr = arm.animation_data.nla_tracks.new(); tr.name = name; st = tr.strips.new(name, 0, act); st.name = name
    arm.animation_data.action = None
    return act

def build_player_anims(arm):
    for pb in arm.pose.bones: pb.rotation_mode = 'XYZ'
    S = math.sin; P = 2 * math.pi
    def idle(t):  return {'Chest': (2 * S(t * P), 0, 0), 'Head': (-1.5 * S(t * P), 0, 0), 'UpperArm.L': (0, 0, -8), 'UpperArm.R': (25, 0, 10), 'Forearm.R': (60, 0, 0)}
    def walk(t):
        s = S(t * P)
        return {'Thigh.L': (30 * s, 0, 0), 'Thigh.R': (-30 * s, 0, 0), 'Shin.L': (max(0, -40 * s), 0, 0), 'Shin.R': (max(0, 40 * s), 0, 0),
                'UpperArm.L': (-20 * s, 0, -8), 'UpperArm.R': (25, 0, 10), 'Forearm.R': (60, 0, 0), 'Spine': (0, 0, 3 * s), 'Chest': (3, 0, 0), 'Head': (-2, 0, -3 * s)}
    def run(t):
        s = S(t * P)
        return {'Thigh.L': (55 * s, 0, 0), 'Thigh.R': (-55 * s, 0, 0), 'Shin.L': (max(0, -70 * s), 0, 0), 'Shin.R': (max(0, 70 * s), 0, 0),
                'UpperArm.L': (-40 * s, 0, -10), 'UpperArm.R': (30, 0, 12), 'Forearm.R': (65, 0, 0), 'Spine': (0, 0, 6 * s), 'Chest': (12, 0, 0), 'Hips': (0, 0, -4 * s), 'Head': (-8, 0, -4 * s)}
    def cidle(t): return {'Thigh.L': (-70, 0, 0), 'Thigh.R': (-70, 0, 0), 'Shin.L': (95, 0, 0), 'Shin.R': (95, 0, 0), 'Spine': (18, 0, 0), 'Chest': (10 + 2 * S(t * P), 0, 0), 'Head': (-20, 0, 0), 'UpperArm.R': (30, 0, 10), 'Forearm.R': (60, 0, 0), 'UpperArm.L': (0, 0, -8)}
    def cwalk(t):
        s = S(t * P); base = cidle(t)
        base.update({'Thigh.L': (-70 + 18 * s, 0, 0), 'Thigh.R': (-70 - 18 * s, 0, 0), 'Shin.L': (95 - 10 * s, 0, 0), 'Shin.R': (95 + 10 * s, 0, 0)}); return base
    _clip(arm, 'idle', 48, idle); _clip(arm, 'walk', 24, walk); _clip(arm, 'run', 16, run); _clip(arm, 'crouch_idle', 48, cidle); _clip(arm, 'crouch_walk', 28, cwalk)

# ----------------------------------------------------------------------------- weapons
# Built with game +Z (barrel) = Blender -Y. cyl axis 'Y' == along the barrel.
def build_weapons():
    black, dark, metal, wood, tan = mat('black', (0.14, 0.15, 0.18), 0.5, 0.45), mat('dark', (0.08, 0.09, 0.11), 0.6, 0.3), mat('metal', (0.6, 0.64, 0.68), 0.3, 0.8), mat('wood', (0.42, 0.28, 0.14), 0.7), mat('tan', (0.71, 0.61, 0.43), 0.75)
    roots = []
    def B(n, s, l, m, bev=0.4): return box(n, s, (l[0], -l[2], l[1]), m, bevel=bev)          # (x, y_up, z_fwd) -> blender
    def C(n, r, L, l, m):        return cyl(n, r, L, (l[0], -l[2], l[1]), m, axis='Y')
    def finish(name, parts):
        r = join(parts, name); r.location = (0, 0, 0); roots.append(r); return r
    def pistol(name, slide_len, slide_mat, barrel_r, barrel_len, extra=None):
        p = [B('grip', (4, 7, 5), (0, -5, -4), black), B('slide', (4.6, 4.6, slide_len), (0, 0, slide_len / 2 - 3), slide_mat, 0.6), B('trig', (4, 2, 8), (0, -2.6, -1), black, 0.2), C('barrel', barrel_r, barrel_len, (0, 0.4, slide_len - 3 + barrel_len / 2), metal)]
        if extra: p += extra()
        return finish(name, p)
    pistol('glock', 16, dark, 1.3, 6); pistol('usp', 16, black, 2.2, 16)
    pistol('deagle', 24, metal, 1.7, 12)
    # r8: revolver with a separate Hammer child (game rotates it on x to cock)
    r8 = finish('r8', [B('grip', (4.5, 8, 6), (0, -5, -5), wood), B('frame', (5, 5, 12), (0, 0, 2), black), C('cyl', 3.4, 8, (0, 0, 1), metal), C('barrel', 1.5, 24, (0, 0.6, 17), metal), B('trig', (4, 2, 8), (0, -2.6, -2), black, 0.2)])
    hb = box('Hammer', (1.6, 5, 2.4), (0, 6, 2.6 + 2.5), metal, bevel=0.3); hb.location = (0, 6, 5.1); parent_to(hb, r8); hb.name = 'Hammer'
    # duals: two pistols side by side
    d = []
    for sx in (-7, 7): d += [B('g' + str(sx), (4, 7, 5), (sx, -5, -4), black), B('s' + str(sx), (4.4, 4.4, 15), (sx, 0, 6), metal, 0.6), B('t' + str(sx), (4, 2, 8), (sx, -2.6, -1), black, 0.2), C('b' + str(sx), 1.1, 8, (sx, 0.4, 15), metal)]
    finish('duals', d)
    # ssg08 bolt-action
    finish('ssg', [C('barrel', 1.3, 70, (0, 1, 18), metal), B('recv', (5, 6, 30), (0, -1, -4), dark), B('mag', (5, 4, 9), (0, -3, -13), dark), B('stock', (5, 7, 22), (0, -2, -30), tan, 1), B('butt', (6, 2, 12), (0, -6, -28), tan, 0.8), C('scope', 2.6, 20, (0, 7, 0), dark), B('ring1', (4, 3, 6), (0, 4, -6), metal), B('ring2', (4, 3, 6), (0, 4, 8), metal), B('bolt', (6, 1.5, 3), (3, 1, -8), metal, 0.3)])
    for key, stockm in (('scar', tan), ('g3', black)):
        finish(key, [C('barrel', 1.6, 60, (0, 2, 22), metal), B('recv', (7, 9, 42), (0, -1, 2), dark, 0.8), B('mag', (6, 15, 9), (0, -13, -4), black), B('grip', (5, 9, 8), (0, -10, -16), black), B('stock', (6, 8, 26), (0, -2, -36), stockm, 1), B('butt', (7, 3, 13), (0, -7, -34), stockm, 0.8), C('scope', 3, 24, (0, 9, 2), dark), B('ring1', (5, 4, 7), (0, 5, -6), metal), B('ring2', (5, 4, 7), (0, 5, 10), metal), B('rail', (3, 1.5, 30), (0, 4, 2), dark, 0.2)])
    kb = box('blade', (0.6, 5, 14), (0.3, -11, 1), metal, bevel=0.2); kb.rotation_euler = (-0.12, 0, 0)
    finish('knife', [B('handle', (2.5, 3, 9), (0, -3, -2), dark, 0.6), B('guard', (1, 4, 1.5), (0, -1, 4), black, 0.2), kb, B('tip', (0.7, 1.5, 5), (0.3, 3, 16), metal, 0.2)])
    return roots

# ----------------------------------------------------------------------------- grenades
def build_nades():
    roots = []
    he = join([sphere('body', 5, (0, 0, 0), mat('nade_he', (0.25, 0.35, 0.18), 0.7, 0.2), 16), box('lever', (1.2, 7, 2), (2.5, 0, 4.5), mat('nade_lever', (0.5, 0.5, 0.52), 0.4, 0.7), bevel=0.2), cyl('fuse', 1.6, 2, (0, 0, 5.5), mat('nade_lever', (0.5, 0.5, 0.52)), axis='Z')], 'he'); he.scale = (1, 1, 1.25); roots.append(he)
    roots.append(join([cyl('can', 3.3, 11, (0, 0, 0), mat('nade_flash', (0.72, 0.74, 0.76), 0.5, 0.4)), cyl('cap', 2.4, 1.5, (0, 0, 6), mat('nade_lever', (0.5, 0.5, 0.52)))], 'flash'))
    roots.append(join([cyl('can', 3.8, 10, (0, 0, 0), mat('nade_smoke', (0.36, 0.39, 0.31), 0.7, 0.2)), cyl('cap', 2.6, 1.5, (0, 0, 5.6), mat('nade_lever', (0.5, 0.5, 0.52))), box('band', (8, 8, 1.2), (0, 0, 0), mat('nade_band', (0.85, 0.85, 0.3), 0.6), bevel=0.2)], 'smoke'))
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
