/*
Copyright (C) 2013 Tor Knutsson - http://tewr.github.io

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

var Svg2b4Emblem = {
    convert: function (svgText, log) {
        // Use a default logging function.
        log = log || function (message) {
            console.log("Svg2b4Emblem:", message);
            displayLog(message);
        };

        var svgDoc;

        try {
            log("Parsing SVG text...");
            svgDoc = (new DOMParser()).parseFromString(svgText, "text/xml");
            if (svgDoc.getElementsByTagName('parsererror').length > 0) {
                log("SVG Parsing Error: " + svgDoc.getElementsByTagName('parsererror')[0].textContent);
                return [];
            }
            log("SVG parsed successfully.");
        } catch (e) {
            log("Unable to load svg: " + e);
            return [];
        }

        var r2d = (180 / Math.PI);

        // Helper functions (kept from previous version, but made more robust)
        function asinDeg(quote) { return r2d * Math.asin(quote); }
        function acosDeg(quote) { return r2d * Math.acos(quote); }
        function getAccumulatedSign() {
            var sign = 1;
            for (var i = 0; i < arguments.length; i++) {
                sign *= ((arguments[i] < 0) ? -1 : 1);
            }
            return sign;
        }

        function getTransformationCalls(transformCall) {
            var calls = [];
            var r = /([a-z]*)\(([0-9\-\. ]*)\)/g;
            var matches = r.exec(transformCall);
            while (matches != null) {
                calls.push({
                    "func": matches[1],
                    "args": $.map(matches[2].split(" "), function (item) { return parseFloat(item); })
                });
                matches = r.exec(transformCall);
            };
            return calls;
        }
        function flattenGroups(ix, item) { //Handle <g> elements
            if (item.tagName === "g") {
                log("Flattening group element.");
                // Recursively process children of the group, applying group transforms
                var groupTransforms = $(item).attr("transform") || ""; // Get group transforms
                return $.makeArray($(item).children().map(function(childIx, child) {
                    var childTransforms = $(child).attr("transform") || "";
                    $(child).attr("transform", groupTransforms + " " + childTransforms); // Combine group and child transforms
                    return flattenGroups(childIx, child); // Recursively flatten
                }));
            }
            return [item];
        }



        function applyTransform(point, transformCalls) {
            let x = point.x;
            let y = point.y;

            for (const call of transformCalls) {
                const args = call.args;
                switch (call.func) {
                    case 'translate':
                        x += args[0] || 0; // Default to 0 if only one argument (or none)
                        y += args[1] || 0; // translate(tx, ty) - ty is optional
                        break;
                    case 'scale':
                        x *= args[0];
                        y *= (args.length > 1) ? args[1] : args[0]; // scale(sx, sy) - sy is optional
                        break;
                    case 'rotate':
                        const angleRad = args[0] * Math.PI / 180;
                        const cos = Math.cos(angleRad);
                        const sin = Math.sin(angleRad);
                        const x1 = x * cos - y * sin;
                        const y1 = x * sin + y * cos;
                        x = x1;
                        y = y1;
                        // Rotate around a point: rotate(angle, cx, cy)
                        if (args.length === 3){
                            x -= args[1];
                            y -= args[2];
                            const rotatedX = x * Math.cos(angleRad) - y * Math.sin(angleRad);
                            const rotatedY = x * Math.sin(angleRad) + y * Math.cos(angleRad);
                            x = rotatedX + args[1];
                            y = rotatedY + args[2];
                        }
                        break;

                    case 'matrix': // matrix(a, b, c, d, e, f)
                        if(args.length === 6){
                            const a = args[0];
                            const b = args[1];
                            const c = args[2];
                            const d = args[3];
                            const e = args[4];
                            const f = args[5];
                            const x1 = a * x + c * y + e;
                            const y1 = b * x + d * y + f;
                            x = x1;
                            y = y1;
                        }

                        break;
                    case 'skewX': // skewX(angle)
                        const angleXRad = args[0] * Math.PI / 180;
                        x += Math.tan(angleXRad) * y;
                        break;
                    case 'skewY':   // skewY(angle)
                        const angleYRad = args[0] * Math.PI /180;
                        y += Math.tan(angleYRad) * x;
                        break;

                    default:
                        log("WARN: Unsupported transformation: " + call.func);
                }
            }

            return { x: x, y: y };
        }



        // *** PATH PARSING ***
        function parsePath(item) {
            log("Processing path element.");
            const pathData = $(item).attr("d");
            if (!pathData) {
                log("WARN: Skipping path - No path data (d attribute).");
                return;
            }

            let fill = $(item).attr("fill");
            if (!fill || fill === "none") {
                fill = "#000000"; // Default fill
            }
            let opacity = $(item).attr("opacity") || 1;
            let transform = $(item).attr("transform") || ""; // Default to no transform
            let transformCalls = getTransformationCalls(transform);


            // Very basic SVG path parsing (handles only M, L, and Z commands for now)
            const commands = pathData.match(/([a-zA-Z])([^a-zA-Z]*)/g);
            if (!commands) {
                log("WARN: Skipping path - Invalid path data (no commands found).");
                return null; // Return null for invalid path data
            }

            let points = [];
            let currentX = 0;
            let currentY = 0;
            let subpathStartX = 0;
            let subpathStartY = 0;


            for (const command of commands) {
                const type = command.charAt(0);
                const values = command.substring(1).trim().split(/[\s,]+/).filter(Boolean).map(parseFloat); // Split by spaces and commas

                //Relative commands
                const isRelative = (type === type.toLowerCase());

                switch (type.toUpperCase()) {
                    case 'M': // moveto (absolute)
                        for (let i = 0; i < values.length; i += 2) {
                            let x = values[i];
                            let y = values[i + 1]
                            if(isRelative){
                                x += currentX;
                                y += currentY;
                            }
                            if (!isNaN(x) && !isNaN(y)) {
                                let transformedPoint = applyTransform({ x: x, y: y }, transformCalls);
                                points.push(transformedPoint);
                                currentX = transformedPoint.x; // Update current position
                                currentY = transformedPoint.y;
                                subpathStartX = currentX; //Store start of subpath
                                subpathStartY = currentY;
                            }
                        }
                        break;
                    case 'L': // lineto (absolute)
                        for (let i = 0; i < values.length; i += 2) {
                             let x = values[i];
                             let y = values[i + 1];
                            if(isRelative){
                                x += currentX;
                                y += currentY;
                            }
                            if (!isNaN(x) && !isNaN(y)) {
                                let transformedPoint = applyTransform({ x: x, y: y }, transformCalls);
                                points.push(transformedPoint);
                                currentX = transformedPoint.x;
                                currentY = transformedPoint.y;
                            }
                        }
                        break;
                    case 'H': // horizontal lineto (absolute)
                        for (const val of values){
                            let x = val;
                            if(isRelative){
                                x += currentX;
                            }
                            let transformedPoint = applyTransform({x: x, y: currentY}, transformCalls);
                            points.push(transformedPoint);
                            currentX = transformedPoint.x;
                        }
                        break;
                    case 'V': // vertical lineto (absolute)
                        for (const val of values){
                            let y = val;
                            if(isRelative){
                                y += currentY;
                            }
                            let transformedPoint = applyTransform({x: currentX, y: y}, transformCalls);
                            points.push(transformedPoint);
                            currentY = transformedPoint.y;
                        }
                        break;
                    case 'Z': // closepath (absolute)
                        // Close the path by drawing a line to the start of the current subpath
                        if (points.length > 0) {
                            let transformedPoint = applyTransform({x: subpathStartX, y: subpathStartY}, transformCalls);
                            points.push(transformedPoint);
                            currentX = transformedPoint.x; //Update current point to start of subpath
                            currentY = transformedPoint.y;
                        }
                        break;

                    case 'C': // curveto (cubic bezier, absolute)

                        for (let i = 0; i < values.length; i += 6) {
                            let x1 = values[i];
                            let y1 = values[i+1];
                            let x2 = values[i+2];
                            let y2 = values[i+3];
                            let x = values[i+4];
                            let y = values[i+5];
                            if(isRelative){
                                x1 += currentX;
                                y1 += currentY;
                                x2 += currentX;
                                y2 += currentY;
                                x += currentX;
                                y += currentY;

                            }

                            if(!isNaN(x1) && !isNaN(y1) && !isNaN(x2) && !isNaN(y2) && !isNaN(x) && !isNaN(y)){

                                //Approximate cubic Bezier curve with lines
                                const STEPS = 20; // Number of line segments
                                for(let j = 0; j <= STEPS; j++){
                                    let t = j / STEPS;
                                    let oneMinusT = 1-t;
                                    let oneMinusT2 = oneMinusT * oneMinusT;
                                    let oneMinusT3 = oneMinusT2 * oneMinusT;
                                    let t2 = t * t;
                                    let t3 = t2 * t;

                                    let lineX = oneMinusT3 * currentX + 3 * oneMinusT2 * t * x1 + 3 * oneMinusT * t2 * x2 + t3 * x;
                                    let lineY = oneMinusT3 * currentY + 3 * oneMinusT2 * t * y1 + 3 * oneMinusT * t2 * y2 + t3 * y;

                                    let transformedPoint = applyTransform({x: lineX, y: lineY}, transformCalls);
                                    points.push(transformedPoint);

                                }
                                let transformedEndPoint = applyTransform({x: x, y: y}, transformCalls);
                                currentX = transformedEndPoint.x;
                                currentY = transformedEndPoint.y;
                            }
                        }

                        break;

                    case 'S': // shorthand/smooth curveto (cubic bezier, absolute)
                      for (let i = 0; i < values.length; i += 4) {
                            let x2 = values[i];
                            let y2 = values[i+1];
                            let x = values[i+2];
                            let y = values[i+3];
                            if(isRelative){
                                x2 += currentX;
                                y2 += currentY;
                                x += currentX;
                                y += currentY;
                            }
                            // Calculate reflection of previous control point
                            let prevCommand = commands[commands.indexOf(command)-1];
                            let x1, y1;

                            if(prevCommand && prevCommand.toUpperCase() === 'C' || prevCommand && prevCommand.toUpperCase() === 'S' ){
                                let pValues = prevCommand.substring(1).trim().split(/[\s,]+/).filter(Boolean).map(parseFloat);
                                let pX2 = pValues[pValues.length - 4];
                                let pY2 = pValues[pValues.length - 3];
                                if (prevCommand.charAt(0) === prevCommand.charAt(0).toLowerCase()){
                                  pX2 += currentX;
                                  pY2 += currentY;
                                }


                                x1 = currentX + (currentX - pX2); //Reflect control point
                                y1 = currentY + (currentY - pY2);
                            } else {
                                //If there is no previous C or S command, the control point is the same as current point
                                x1 = currentX;
                                y1 = currentY;
                            }

                            if(!isNaN(x1) && !isNaN(y1) && !isNaN(x2) && !isNaN(y2) && !isNaN(x) && !isNaN(y)){
                                //Approximate cubic Bezier curve with lines
                                const STEPS = 20; // Number of line segments
                                for(let j = 0; j <= STEPS; j++){
                                    let t = j / STEPS;
                                    let oneMinusT = 1-t;
                                    let oneMinusT2 = oneMinusT * oneMinusT;
                                    let oneMinusT3 = oneMinusT2 * oneMinusT;
                                    let t2 = t * t;
                                    let t3 = t2 * t;

                                    let lineX = oneMinusT3 * currentX + 3 * oneMinusT2 * t * x1 + 3 * oneMinusT * t2 * x2 + t3 * x;
                                    let lineY = oneMinusT3 * currentY + 3 * oneMinusT2 * t * y1 + 3 * oneMinusT * t2 * y2 + t3 * y;

                                    let transformedPoint = applyTransform({x: lineX, y: lineY}, transformCalls);
                                    points.push(transformedPoint);

                                }
                                let transformedEndPoint = applyTransform({x: x, y: y}, transformCalls);
                                currentX = transformedEndPoint.x;
                                currentY = transformedEndPoint.y;

                            }
                      }
                      break;
                    case 'Q': // quadratic Bezier curveto (absolute)

                        for(let i = 0; i < values.length; i += 4) {
                            let x1 = values[i];
                            let y1 = values[i + 1];
                            let x = values[i + 2];
                            let y = values[i + 3];

                            if(isRelative){
                                x1 += currentX;
                                y1 += currentY;
                                x += currentX;
                                y += currentY;
                            }
                            if(!isNaN(x1) && !isNaN(y1) && !isNaN(x) && !isNaN(y)){
                                const STEPS = 20;
                                for(let j = 0; j <= STEPS; j++){
                                    let t = j/STEPS;
                                    let oneMinusT = 1 - t;
                                    let oneMinusT2 = oneMinusT * oneMinusT;
                                    let t2 = t * t;

                                    let lineX = oneMinusT2 * currentX + 2 * oneMinusT * t * x1 + t2 * x;
                                    let lineY = oneMinusT2 * currentY + 2 * oneMinusT * t * y1 + t2 * y;
                                    let transformedPoint = applyTransform({x: lineX, y: lineY}, transformCalls);
                                    points.push(transformedPoint);
                                }
                                let transformedEndPoint = applyTransform({x:x, y:y}, transformCalls);
                                currentX = transformedEndPoint.x;
                                currentY = transformedEndPoint.y;
                            }
                        }
                        break;
                    case 'T': // Shorthand/smooth quadratic Bezier curveto (absolute)
                        for (let i = 0; i < values.length; i+=2){
                            let x = values[i];
                            let y = values[i + 1];
                            if(isRelative){
                                x += currentX;
                                y += currentY;
                            }
                            let prevCommand = commands[commands.indexOf(command) - 1];
                            let x1, y1;
                            if(prevCommand && prevCommand.toUpperCase() === 'Q' || prevCommand && prevCommand.toUpperCase() === 'T'){

                                let pValues = prevCommand.substring(1).trim().split(/[\s,]+/).filter(Boolean).map(parseFloat);
                                let pX1 = pValues[pValues.length - 4]; // Control point of previous Q
                                let pY1 = pValues[pValues.length - 3];

                                 if (prevCommand.charAt(0) === prevCommand.charAt(0).toLowerCase()){
                                  pX1 += currentX;
                                  pY1 += currentY;
                                }
                                x1 = currentX + (currentX - pX1); //Reflect control point
                                y1 = currentY + (currentY - pY1);
                            } else {
                                x1 = currentX;
                                y1 = currentY;
                            }
                            if(!isNaN(x1) && !isNaN(y1) && !isNaN(x) && !isNaN(y)){
                                const STEPS = 20;
                                for(let j = 0; j <= STEPS; j++){
                                    let t = j/STEPS;
                                    let oneMinusT = 1 - t;
                                    let oneMinusT2 = oneMinusT * oneMinusT;
                                    let t2 = t * t;

                                    let lineX = oneMinusT2 * currentX + 2 * oneMinusT * t * x1 + t2 * x;
                                    let lineY = oneMinusT2 * currentY + 2 * oneMinusT * t * y1 + t2 * y;
                                    let transformedPoint = applyTransform({x: lineX, y: lineY}, transformCalls);
                                    points.push(transformedPoint);
                                }
                                 let transformedEndPoint = applyTransform({x:x, y:y}, transformCalls);
                                currentX = transformedEndPoint.x;
                                currentY = transformedEndPoint.y;
                            }

                        }
                        break;
                    case 'A': // Elliptical arc (absolute)

                      for (let i = 0; i < values.length; i += 7) {
                        let rx = values[i];
                        let ry = values[i + 1];
                        let xAxisRotation = values[i + 2];
                        let largeArcFlag = values[i + 3];
                        let sweepFlag = values[i + 4];
                        let x = values[i + 5];
                        let y = values[i + 6];
                        if(isRelative){
                            x += currentX;
                            y += currentY;
                        }

                        if (!isNaN(rx) && !isNaN(ry) && !isNaN(xAxisRotation) && !isNaN(largeArcFlag) && !isNaN(sweepFlag) && !isNaN(x) && !isNaN(y)) {

                            // Conversion from endpoint to center parametrization
                            // See: https://www.w3.org/TR/SVG/implnote.html#ArcConversionEndpointToCenter
                            let xAxisRotationRad = xAxisRotation * Math.PI / 180;
                            let cosPhi = Math.cos(xAxisRotationRad);
                            let sinPhi = Math.sin(xAxisRotationRad);
                            let x1p =  (cosPhi * (currentX - x) / 2) + (sinPhi * (currentY - y) / 2);
                            let y1p = (-sinPhi * (currentX - x) / 2) + (cosPhi * (currentY - y) / 2);

                            // Ensure radii are non-zero and positive
                            rx = Math.abs(rx);
                            ry = Math.abs(ry);

                            //Check if radii are large enough
                            let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
                            if(lambda > 1){
                                rx = Math.sqrt(lambda) * rx;
                                ry = Math.sqrt(lambda) * ry;
                            }

                            let rx2 = rx * rx;
                            let ry2 = ry * ry;
                            let x1p2 = x1p * x1p;
                            let y1p2 = y1p * y1p;


                            let sign = (largeArcFlag === sweepFlag) ? -1 : 1;
                            let radicand = ( (rx2 * ry2) - (rx2 * y1p2) - (ry2 * x1p2) ) / ( (rx2 * y1p2) + (ry2 * x1p2) )

                            //If radicand is negative, make it 0 (numerical stability)
                            radicand = Math.max(0, radicand);

                            let coeff = sign * Math.sqrt(radicand);

                            let cxp = coeff *  ( (rx * y1p) / ry);
                            let cyp = coeff * -( (ry * x1p) / rx);

                            let cx = (cosPhi * cxp) + (-sinPhi * cyp) + ((currentX + x) / 2);
                            let cy = (sinPhi * cxp) + ( cosPhi * cyp) + ((currentY + y) / 2);

                            let ux = ( x1p - cxp) / rx;
                            let uy = ( y1p - cyp) / ry;
                            let vx = (-x1p - cxp) / rx;
                            let vy = (-y1p - cyp) / ry;


                            //Calculate the angle start
                            let n = Math.sqrt( (ux * ux) + (uy * uy) );
                            let p = ux; // Dot product
                            sign = (uy < 0) ? -1 : 1;
                            let angleStart = sign * Math.acos( p / n ) * 180 / Math.PI;

                            //Calculate angle extent
                            n = Math.sqrt( (ux * ux + uy * uy) * (vx * vx + vy * vy) );
                            p = ux * vx + uy * vy;
                            sign = (ux * vy - uy * vx < 0) ? -1.0 : 1.0;
                            let angleExtent = sign * Math.acos(p / n) * 180 / Math.PI;

                            if(!sweepFlag && angleExtent > 0) {
                                angleExtent -= 360;
                            } else if (sweepFlag && angleExtent < 0) {
                                angleExtent += 360;
                            }
                            angleExtent %= 360;
                            angleStart %= 360;

                           const STEPS = 20; // Number of line segments to approximate the arc
                            for (let j = 0; j <= STEPS; j++) {
                                let angle = angleStart + (angleExtent * j / STEPS);
                                let angleRad = angle * Math.PI / 180;

                                let lineX = cx + rx * Math.cos(angleRad) * cosPhi - ry * Math.sin(angleRad) * sinPhi;
                                let lineY = cy + rx * Math.cos(angleRad) * sinPhi + ry * Math.sin(angleRad) * cosPhi;


                                let transformedPoint = applyTransform({ x: lineX, y: lineY }, transformCalls);
                                points.push(transformedPoint);
                            }
                            let transformedEndPoint = applyTransform({x:x, y:y}, transformCalls);
                            currentX = transformedEndPoint.x;
                            currentY = transformedEndPoint.y;
                        }
                      }

                    break;

                    default:
                        log("WARN: Unsupported path command: " + type);
                }
            }


            if (points.length === 0) {
                log("WARN: Path produced no points.");
                return null;
            }

            // Find bounding box of the points
            let minX = Infinity, minY = Infinity;
            let maxX = -Infinity, maxY = -Infinity;
            for (const point of points) {
                minX = Math.min(minX, point.x);
                minY = Math.min(minY, point.y);
                maxX = Math.max(maxX, point.x);
                maxY = Math.max(maxY, point.y);
            }

            //Center of the path
            const centerX = (minX + maxX) / 2;
            const centerY = (minY + maxY) /2;
            const width = maxX - minX;
            const height = maxY - minY;

            return {
                "asset": "Square", // Battlefield 4 doesn't support paths, so we approximate with a rectangle
                "left": centerX,
                "top": centerY,
                "fill": fill,
                "width": width,
                "height": height,
                "angle": 0,  // We'll try to get a rotation later
                "opacity": opacity,
                "selectable": true
            };
        }

        // Main processing loop
        var results = [];

        try {
          $("svg", svgDoc).children().map(flattenGroups).each(function (ix, item) {
            var result = null;  // Initialize result to null

            if (item.tagName === "path") {
                result = parsePath(item);
            } else if (item.tagName === "line") {
                result = treatItem(item); // Call existing treatItem for lines
            } else if (item.tagName === "rect") {
                result = treatItem(item); // Call existing treatItem for rectangles
            } else if (item.tagName === "ellipse") {
                result = treatItem(item);  // Call existing treatItem for ellipses
            }
             else {
                log("WARN: Skipped unsupported object " + item.tagName);
            }

            if (result) {
                results.push(result);
                log("Processed item: " + JSON.stringify(result));
            } else if (result === null) { // Only log if parsePath explicitly returned null
                log("Failed to process item: " + item.tagName);
            }

          });
        } catch(e){
            log("Error during element processing: "+ e);
            return []; // Return empty array on error
        }

        if (results.length > 40) {
            log("WARN: Too many objects - some objects will not be visible. Max is 40, found " + results.length);
        }

        log("Conversion complete.  Total items processed: " + results.length);
        return results;
    }
};


// Helper function to display logs (kept from before)
function displayLog(message) {
    var logDiv = document.getElementById('logOutput');
    if (!logDiv) {
        logDiv = document.createElement('div');
        logDiv.id = 'logOutput';
        logDiv.style.marginTop = '20px';
        logDiv.style.border = '1px solid #ccc';
        logDiv.style.padding = '10px';
        document.body.appendChild(logDiv);
    }

    var logEntry = document.createElement('p');
    logEntry.textContent = message;
    logDiv.appendChild(logEntry);
}