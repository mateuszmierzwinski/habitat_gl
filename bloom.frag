#version 330 core
// Bloom pyramid, dual filtering: uA.z = 0 halves the source, 1 expands it back (drawn additively).
out vec4 O;
uniform sampler2D T;
uniform vec4 uA; // xy target resolution, z mode, w gain

void main() {
    vec2 uv = gl_FragCoord.xy / uA.xy, h = .5 / uA.xy;
    vec3 c;
    if (uA.z < .5) {
        c = (texture(T, uv).rgb * 4. + texture(T, uv - h).rgb + texture(T, uv + h).rgb +
             texture(T, uv + vec2(h.x, -h.y)).rgb + texture(T, uv - vec2(h.x, -h.y)).rgb) / 8.;
    } else {
        h *= 2.;
        c = (texture(T, uv + vec2(-h.x * 2., 0.)).rgb + texture(T, uv + vec2(h.x * 2., 0.)).rgb +
             texture(T, uv + vec2(0., h.y * 2.)).rgb + texture(T, uv + vec2(0., -h.y * 2.)).rgb +
             2. * (texture(T, uv + vec2(-h.x, h.y)).rgb + texture(T, uv + h).rgb +
                   texture(T, uv + vec2(h.x, -h.y)).rgb + texture(T, uv - h).rgb)) / 12.;
    }
    O = vec4(c * uA.w, 1.);
}
